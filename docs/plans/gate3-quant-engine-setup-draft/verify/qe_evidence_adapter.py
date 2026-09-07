#!/usr/bin/env python3
"""Baseline-owned semantic-proof adapter for the qe_evidence package.

Invoked only as:

    python3 verify/qe_evidence_adapter.py --target verify/cases/<name>

Candidate paths never reach argv under the CCC-Fusion Python verifier profile,
so this file locates the code under test itself: it puts ``src`` on
``sys.path`` and imports ``qe_evidence`` from a hardcoded location. It reads
its oracle from ``<target>/cases.json`` and judges observable behaviour only.

Two-way honest classification
-----------------------------
Every outcome is attributed to exactly one of two parties, and the two are
never conflated:

*The candidate is wrong* -- any exception of any kind (including
``SystemExit`` from a ``sys.exit()`` call, ``KeyboardInterrupt`` from a
``raise KeyboardInterrupt``, ``RecursionError``, and a ``SyntaxError`` in a
candidate source file) raised while locating, importing,
or calling candidate code, plus any wrong value a check observes. This exits
1 after writing one line of canonical JSON, the CCC-Fusion
``ccc-prd.proof-evidence.v2`` envelope, with ``passed`` false and a false
result for each declared id whose mapped evidence failed. Fusion records a
graded proof failure.

*The harness cannot run a real proof* -- bad arguments, a missing, unparseable
or structurally invalid ``cases.json``, a missing or contradictory
``CCC_PROOF_*`` environment variable, an evidence-mapping defect, or a bug in
this file (including a failure to serialize or write the envelope). This
writes NOTHING to stdout, one ``HARNESS REFUSED`` line to stderr, and exits 2.
Fusion sees empty stdout and classifies the dispatch as ``no_output``, a
refusal, never a verified failure.

The split matters because a refusal and a graded failure mean opposite things
to the campaign, and candidate code must not be able to choose between them.
That is why the fixture's full shape is validated before any candidate code
runs (so a ``KeyError`` inside a check can only come from the candidate),
why candidate calls are guarded with ``except BaseException`` rather than
``except Exception``, and why stdout is taken into custody at file-descriptor
level (below) rather than trusting ``sys.stdout`` to still be there.

Two callers, two modes
----------------------
The same Taskfile command is run by two different callers who need different
things from it, and the four ``CCC_PROOF_*`` variables are what tells them
apart.

*Proof mode*, all four set. Fusion's proof harness is asking for admissible
evidence. It gets the envelope on stdout, and the exit code alongside it.

*Developer mode*, none of the four set. The campaign worker is running its own
verify step to find out whether the code it just wrote is right, and it reads
that answer from the exit code. Its sandbox builds the child environment from
scratch, so it does not set these variables and cannot. Every check runs
exactly as it does in proof mode; the human summary and a per-check ledger go
to stderr; stdout stays empty; the exit code is 0 or 1 by the same conjunction
of declared ids.

*Anything in between* -- some set and some not, or any of them empty -- is
refused exactly as before. A partial identity is not a caller, it is a
dispatch defect.

The rule this splits on: the exit code serves the worker's verify gate, the
envelope serves Fusion's proof harness, and the envelope must never be emitted
with a borrowed identity. Filling in placeholder values so that developer mode
could emit "something" would be worse than emitting nothing, because an
envelope is a claim about a named proof at a named commit, and a run that
knows neither has no such claim to make.

Exit codes, in both modes:
    0  every declared id's mapped evidence ran and passed
    1  the candidate implementation is wrong (proof failure; in proof mode an
       envelope is emitted, in developer mode nothing is)
    2  the harness could not run a real proof (no stdout at all)

Exit 2 covers this file's own defects as well as a broken fixture or a
half-supplied identity: reading the ledger, building the envelope and writing
the developer-mode report are all this file's work, and a crash in any of them
refuses rather than exiting 1, because exit 1 is the verdict "the candidate is
wrong" and that verdict was never reached. The one place this cannot apply is
after the envelope has already been written, since exit 2 promises an empty
stdout and that promise is no longer available to keep.

What this file is defending against, and what it is not
-------------------------------------------------------
This referee must be honest and non-vacuous against an ordinary or wrong
candidate written by an LLM worker whose output lands as a reviewable pull
request. Deliberate evasion by candidate code -- dynamic import tricks that
hide a module from both the source scan and sys.modules, raising this file's
own HarnessError from __main__, os._exit, closing the descriptors this file
holds -- is out of scope: every such path ends as a Fusion refusal or a
visible code-review smell, never as a pass. No defences against those are
built here, and none should be.

Explicit evidence mapping
-------------------------
``PROOF_DECLARATIONS`` maps every declared acceptance clause id, positive-case
id and negative-control id of each target to the non-empty set of check ids
that actually prove it, each mapping carrying the PRD sentence it comes from.
A declared id's result is the conjunction of its mapped checks; the envelope's
top-level ``passed`` is the conjunction of every declared id's result. There is
no positive/negative bucket heuristic: a clause whose negative evidence failed
reports false, and a negative control can only report true if the checks that
actually exercise refusal ran and passed.

``validate_phase_declarations`` holds the table to the PRD on every run, in
three ways. Each phase must declare exactly the clause ids, case ids and
control ids the PRD's expected-proof paragraph names for it, so a proof cannot
weaken itself by quietly declaring less. Any id declared at more than one
phase must be proved at the later phase by at least the evidence the earlier
one demanded. And wherever the integrate clause appears it must carry the leaf
phases' own evidence, because its text requires that the join changed no leaf
behaviour.

Vacuity is refused at load time, before any check runs: a declared id with no
mapped checks, a mapped check the fixture does not declare, or a fixture check
mapped to no declared id is a ``HarnessError``. So is a fixture whose
"invalid" label inputs are all actually admitted, whose "invalid" gate mappings
actually carry the declared gate names, whose join controls do not cover a
missing export, a renamed export and a restated export (the last for both a
callable and a plain-value export, since copying a function and copying a
tuple fail along different code paths), or whose stdlib controls do not cover
both a runtime import and a source import. The check ledger additionally
refuses any run whose executed checks differ from the fixture's declared set.

Two of the sixteen checks are instrument calibration rather than candidate
observation: ``package_join_control`` and ``stdlib_import_control`` feed the
same predicates the real join and import checks use a deliberately broken
shape declared in the fixture (a package missing one joined leaf export, a
package exporting a renamed name, a package restating rather than joining an
export, a runtime that pulled in a third-party module, a source file importing
a non-stdlib or first-party package) and fail unless every one is refused --
after first confirming the predicate accepts the faithful shape. Without them
"the negative control passed" would only mean "the candidate did not happen to
trip it". A restated stand-in that turned out to be the original object (which
is what ``tuple(some_tuple)`` returns) is itself refused, because a control
that has quietly become the faithful shape would fail a correct candidate.

``stdlib_only_imports`` reads every ``.py`` file in the candidate package, not
only the ones the target requires, so an import cannot be parked in an
undeclared helper module.

Stdout custody
--------------
Stdout is the whole proof signal, so this file takes it away from the
candidate. On entry ``main`` duplicates file descriptor 1 onto two private
high-numbered descriptors and points descriptor 1 at stderr, then also
redirects ``sys.stdout`` to ``sys.stderr`` for the whole candidate phase. A
candidate's ``print()``, a rebound ``sys.stdout``, and a raw
``os.write(1, ...)`` all land on stderr. The duplicates sit high on purpose:
the lowest free descriptor is what the next ``open()`` in candidate code is
handed, so a private handle placed there could be reused by the code under
test. Two are kept so that closing one does not silence the proof; the
envelope is encoded first, then written as bytes in a single full-write loop,
and a handle that already wrote part of the line is never retried on the other
(both refer to the same open file, so retrying would duplicate bytes). If
every handle fails, the run falls back to the exit-2 no-stdout path rather
than emitting a partial line.

Accepted residual: a candidate that calls ``os._exit()``, or that closes every
saved descriptor, ends the run with no envelope at all, which reaches Fusion
as a ``no_output`` refusal and never as a pass.

The human-readable ``PROOF PASSED`` / ``PROOF FAILED`` / ``HARNESS REFUSED``
lines go to stderr only. Fusion's parser (``parseSemanticProofEvidence`` in
``packages/engine/src/ccc-campaign-proof-execution.ts``) re-derives the
canonical form byte for byte and refuses anything else, prose included.

Proof identity (``proofId``, ``phase``, ``sourceCommit``, ``sourceTree``) comes
from the ``CCC_PROOF_ID``, ``CCC_PROOF_PHASE``, ``CCC_PROOF_SOURCE_COMMIT``,
and ``CCC_PROOF_SOURCE_TREE`` environment variables the harness sets for every
dispatch (see the ``proofEnvironment`` object in
``ccc-campaign-proof-execution.ts``); in proof mode all four are required and
non-empty, and ``CCC_PROOF_ID`` must equal the target's pinned proof id,
otherwise the run is refused rather than emitting an envelope shaped for a
different proof. When none of the four is set at all this is developer mode,
described above, and no envelope is produced. The
declared ``clauseIds``/``positiveCases``/``negativeControls`` id lists are not
passed through the environment or argv, so they are pinned here from the
compiled PRD proof definitions (round-7 compiled plan, ``PROOF-EVIDENCE-LABELS``
/ ``-VERDICT`` / ``-CANDIDATE`` / ``-INTEGRATED``).

Accepted canonical-JSON value domain (``canonical_json``): ``str``, ``bool``,
``int``, ``None``, ``list``/``tuple`` of accepted values, and ``dict`` with
``str`` keys and accepted values. This envelope never carries a float, and
``JSON.stringify``'s shortest-round-trip number formatting has no exact
Python equivalent worth risking, so a float -- or anything else outside this
domain -- is refused with a ``HarnessError`` rather than silently
mis-encoded. Object keys are sorted by UTF-16 code unit
(``compareCccPrdCodeUnits``, ``packages/core/src/ccc-prd/contract.ts``), not
Python's default code-point order (they agree everywhere except an astral
character, which never appears in this envelope's keys); strings are encoded
character by character to match ``JSON.stringify``'s escape table exactly,
including ``\\uXXXX`` for a lone (unpaired) UTF-16 surrogate, which
``JSON.stringify`` also escapes rather than emitting raw.

Standard library only. No subprocess, no network, no clock, no randomness,
no writes.
"""

from __future__ import annotations

import ast
import contextlib
import importlib
import importlib.util
import json
import os
import sys
from importlib.machinery import ModuleSpec
from types import SimpleNamespace

FIXTURE_SCHEMA = "qe-evidence-cases.v1"
PACKAGE = "qe_evidence"
SOURCE_ROOT = "src"
CANDIDATE_DIR = os.path.join(SOURCE_ROOT, PACKAGE)
CASES_FILENAME = "cases.json"
TARGET_PARENT = os.path.join("verify", "cases")

PROOF_ENV_VARS = (
    "CCC_PROOF_ID",
    "CCC_PROOF_PHASE",
    "CCC_PROOF_SOURCE_COMMIT",
    "CCC_PROOF_SOURCE_TREE",
)

# Which candidate files must exist before the target can prove anything, and
# whether the proof must execute the package __init__ (a real join) or may
# load leaf modules under a synthetic package shim.
TARGET_REQUIREMENTS = {
    "labels": (("labels.py",), False),
    "verdict": (("labels.py", "verdict.py"), False),
    "candidate": (("labels.py", "verdict.py", "__init__.py"), True),
    "integrated": (("labels.py", "verdict.py", "__init__.py"), True),
}

PACKAGE_EXPORTS = (
    ("EVIDENCE_LABELS", "labels"),
    ("DISQUALIFYING_LABELS", "labels"),
    ("canonical_labels", "labels"),
    ("merge_labels", "labels"),
    ("PROMOTION_GATES", "verdict"),
    ("derive_promotion", "verdict"),
)

VERDICT_FIELDS = ("promotable", "labels", "blocking_reasons")

POINT_IN_TIME = "POINT_IN_TIME_PROVIDER"
PROMOTABLE = "PROMOTABLE"


class HarnessError(Exception):
    """The harness cannot run a real proof. Never a candidate verdict.

    Raising this always means: write nothing to stdout, say why on stderr,
    exit 2, and let Fusion refuse the dispatch as ``no_output``.
    """


class ProofFailure(Exception):
    """The candidate implementation violates the declared contract."""


# ---------------------------------------------------------------------------
# check ledger
# ---------------------------------------------------------------------------


class Ledger:
    """Records the pass/fail outcome of every declared check without
    aborting the run on an individual failure, then refuses any run whose
    executed checks differ from the declared set.

    Recording (not stopping) on failure is what lets the run finish every
    declared check and hand back an accurate per-id result even when some of
    them failed -- the alternative, aborting on the first failure, can never
    report "this clause holds, but that unrelated control does not" in the
    same envelope.
    """

    def __init__(self, required):
        self.required = tuple(required)
        self.executed = []
        self.outcomes = {}

    def record(self, check_id, passed, detail=None):
        if check_id in self.outcomes:
            raise HarnessError("check ran twice: " + check_id)
        self.executed.append(check_id)
        self.outcomes[check_id] = (passed, detail)

    def finish(self):
        required = set(self.required)
        executed = set(self.outcomes)
        if required != executed:
            missing = sorted(required - executed)
            extra = sorted(executed - required)
            raise HarnessError(
                "check ledger mismatch; never ran="
                + repr(missing)
                + " ran but not declared="
                + repr(extra)
            )
        if not executed:
            raise HarnessError("check ledger is empty; refusing a vacuous pass")


# ---------------------------------------------------------------------------
# small assertion helpers
# ---------------------------------------------------------------------------


def fail(message):
    raise ProofFailure(message)


def require(condition, message):
    if not condition:
        fail(message)


def require_str_tuple(value, label):
    require(isinstance(value, tuple), label + " must be a tuple, got " + type(value).__name__)
    for item in value:
        require(isinstance(item, str), label + " must contain only str, got " + repr(item))


def require_canonical(value, label):
    require_str_tuple(value, label)
    require(list(value) == sorted(value), label + " is not in ascending lexicographic order: " + repr(value))
    require(len(set(value)) == len(value), label + " repeats an entry: " + repr(value))


# ---------------------------------------------------------------------------
# candidate location and import
#
# Everything in this section touches candidate-owned state, so every failure
# is a ProofFailure (graded, exit 1) -- with one exception: a missing ``src``
# directory means this process is not running in the quant-engine repository
# at all, which is a dispatch defect, not a candidate defect.
# ---------------------------------------------------------------------------


def locate_candidate(required_files):
    """Prove the candidate exists on disk before any import is attempted."""
    repo_src = os.path.abspath(SOURCE_ROOT)
    if not os.path.isdir(repo_src):
        raise HarnessError("source root is missing, so this is not the target repository: " + repo_src)
    package_dir = os.path.abspath(CANDIDATE_DIR)
    if not os.path.isdir(package_dir):
        fail(
            "candidate package directory does not exist: "
            + package_dir
            + " (the campaign wrote no implementation)"
        )
    for name in required_files:
        path = os.path.join(package_dir, name)
        if not os.path.isfile(path):
            fail("candidate file is missing: " + path)
        if os.path.getsize(path) == 0:
            fail("candidate file is empty: " + path)
    return repo_src, package_dir


def install_source_root(repo_src):
    """PYTHONPATH=src is unrepresentable in the proof command, so do it here."""
    sys.dont_write_bytecode = True
    while repo_src in sys.path:
        sys.path.remove(repo_src)
    sys.path.insert(0, repo_src)


def shim_package(package_dir):
    """Expose qe_evidence as a package without executing its __init__.

    Leaf proofs must be able to judge labels.py before the integrate task has
    written a real __init__.py, while still resolving relative imports such as
    ``from .labels import EVIDENCE_LABELS`` inside verdict.py.
    """
    spec = ModuleSpec(PACKAGE, None, is_package=True)
    spec.submodule_search_locations = [package_dir]
    module = importlib.util.module_from_spec(spec)
    sys.modules[PACKAGE] = module
    return module


def import_candidate(package_dir, required_files, execute_init):
    """Import the candidate.

    Any failure is the candidate's: a module-level ``sys.exit()`` raises
    ``SystemExit``, a malformed file raises ``SyntaxError``, unbounded
    recursion raises ``RecursionError``, and none of those are exceptions
    ``except Exception`` would even see. All of them are graded, so a
    candidate cannot force a refusal by refusing to import.
    """
    baseline_modules = set(sys.modules)
    loaded = {}
    try:
        if execute_init:
            loaded["package"] = importlib.import_module(PACKAGE)
        else:
            shim_package(package_dir)
        if "labels.py" in required_files:
            loaded["labels"] = importlib.import_module(PACKAGE + ".labels")
        if "verdict.py" in required_files:
            loaded["verdict"] = importlib.import_module(PACKAGE + ".verdict")
    except BaseException as error:  # noqa: BLE001 - see the docstring above
        fail(
            "candidate could not be imported: "
            + type(error).__name__
            + ": "
            + str(error)
        )
    if execute_init:
        loaded.setdefault("labels", sys.modules.get(PACKAGE + ".labels"))
        loaded.setdefault("verdict", sys.modules.get(PACKAGE + ".verdict"))
    for key, module in loaded.items():
        if module is None:
            fail("candidate module did not load: " + key)
    new_top_level = sorted(
        {name.split(".", 1)[0] for name in set(sys.modules) - baseline_modules}
    )
    return loaded, new_top_level


def resolve_attr(loaded, module_key, name):
    module = loaded.get(module_key)
    if module is None:
        # Unreachable: validate_declared_checks proves every declared check's
        # modules are loaded for its target before any check runs. Kept as a
        # refusal because reaching it would be a defect in this file.
        raise HarnessError("module not loaded for this target: " + module_key)
    if not hasattr(module, name):
        fail(PACKAGE + "." + module_key + " does not export " + name)
    return getattr(module, name)


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------


def require_exported_tuple(value, label):
    """Refuse an export that is not literally a tuple.

    "Frozen" is a claim about the object the package hands out, not about a
    copy this file made of it. Calling ``tuple(value)`` first would launder a
    list, a set, or any other iterable into a passing result, and a caller
    who received a list could then mutate the vocabulary in place -- which is
    the whole thing these two checks exist to rule out. A tuple subclass is
    still a tuple and is accepted; a set is refused before its contents are
    even looked at, because a set has no order to compare.

    ``require_canonical`` already asserts tuple-ness as its first act. The
    only thing this wrapper adds is a name at the call site saying that what
    reaches it must be the exported object itself and never a copy of it.
    """
    require_canonical(value, label)


def check_vocabulary_frozen(ctx):
    labels_value = resolve_attr(ctx["loaded"], "labels", "EVIDENCE_LABELS")
    disq_value = resolve_attr(ctx["loaded"], "labels", "DISQUALIFYING_LABELS")
    require_exported_tuple(labels_value, "EVIDENCE_LABELS")
    require_exported_tuple(disq_value, "DISQUALIFYING_LABELS")
    require(
        tuple(labels_value) == tuple(ctx["fixture"]["vocabulary"]),
        "EVIDENCE_LABELS is not the frozen admitted vocabulary: " + repr(tuple(labels_value)),
    )
    require(
        tuple(disq_value) == tuple(ctx["fixture"]["disqualifying"]),
        "DISQUALIFYING_LABELS is not the frozen disqualifying set: " + repr(tuple(disq_value)),
    )


def check_promotion_gates_frozen(ctx):
    gates = resolve_attr(ctx["loaded"], "verdict", "PROMOTION_GATES")
    require_exported_tuple(gates, "PROMOTION_GATES")
    require(
        tuple(gates) == tuple(ctx["fixture"]["gates"]),
        "PROMOTION_GATES is not the frozen gate set: " + repr(tuple(gates)),
    )


def check_canonical_labels_positive(ctx):
    canonical_labels = resolve_attr(ctx["loaded"], "labels", "canonical_labels")
    for case in ctx["fixture"]["canonical_labels_cases"]:
        observed = canonical_labels(list(case["input"]))
        expected = tuple(case["expected"])
        require(
            tuple(observed) == expected,
            "canonical_labels " + case["name"] + " expected " + repr(expected) + " got " + repr(observed),
        )
        for label in case["input"]:
            require(
                label in observed,
                "canonical_labels " + case["name"] + " dropped input label " + repr(label),
            )


def check_canonical_labels_order_and_type(ctx):
    canonical_labels = resolve_attr(ctx["loaded"], "labels", "canonical_labels")
    for case in ctx["fixture"]["canonical_labels_cases"]:
        observed = canonical_labels(list(case["input"]))
        require_canonical(observed, "canonical_labels " + case["name"] + " result")


def check_canonical_labels_rejects_invalid(ctx):
    canonical_labels = resolve_attr(ctx["loaded"], "labels", "canonical_labels")
    for case in ctx["fixture"]["canonical_labels_invalid"]:
        try:
            observed = canonical_labels(list(case["input"]))
        except ValueError:
            continue
        except BaseException as error:  # noqa: BLE001 - a candidate that dies
            # some other way still failed to raise the declared ValueError.
            fail(
                "canonical_labels "
                + case["name"]
                + " raised "
                + type(error).__name__
                + " instead of ValueError"
            )
        else:
            fail(
                "canonical_labels "
                + case["name"]
                + " accepted an invalid label set and returned "
                + repr(observed)
            )


def check_merge_labels_positive(ctx):
    merge_labels = resolve_attr(ctx["loaded"], "labels", "merge_labels")
    for case in ctx["fixture"]["merge_labels_cases"]:
        observed = merge_labels(list(case["existing"]), list(case["incoming"]))
        expected = tuple(case["expected"])
        require(
            tuple(observed) == expected,
            "merge_labels " + case["name"] + " expected " + repr(expected) + " got " + repr(observed),
        )
        require_canonical(observed, "merge_labels " + case["name"] + " result")


def check_merge_labels_preserves_inputs(ctx):
    """Union completeness derived independently of the fixture's expected value."""
    merge_labels = resolve_attr(ctx["loaded"], "labels", "merge_labels")
    for case in ctx["fixture"]["merge_labels_cases"]:
        observed = merge_labels(list(case["existing"]), list(case["incoming"]))
        for label in list(case["existing"]) + list(case["incoming"]):
            require(
                label in observed,
                "merge_labels " + case["name"] + " lost input label " + repr(label),
            )
        require(
            set(observed) == set(case["existing"]) | set(case["incoming"]),
            "merge_labels " + case["name"] + " invented or removed a label: " + repr(observed),
        )


def _judge_verdict(case, derive_promotion):
    verdict = derive_promotion(list(case["labels"]), dict(case["gates"]))
    for field in VERDICT_FIELDS:
        require(
            hasattr(verdict, field),
            "derive_promotion " + case["name"] + " result lacks field " + field,
        )
    promotable = getattr(verdict, "promotable")
    labels = getattr(verdict, "labels")
    reasons = getattr(verdict, "blocking_reasons")
    require(
        isinstance(promotable, bool),
        "derive_promotion " + case["name"] + " promotable must be bool, got " + repr(promotable),
    )
    require(
        promotable == case["expected_promotable"],
        "derive_promotion "
        + case["name"]
        + " expected promotable="
        + repr(case["expected_promotable"])
        + " got "
        + repr(promotable),
    )
    require_canonical(labels, "derive_promotion " + case["name"] + " labels")
    require_canonical(reasons, "derive_promotion " + case["name"] + " blocking_reasons")
    require(
        tuple(labels) == tuple(case["expected_labels"]),
        "derive_promotion "
        + case["name"]
        + " expected labels "
        + repr(tuple(case["expected_labels"]))
        + " got "
        + repr(tuple(labels)),
    )
    if promotable:
        require(
            PROMOTABLE in labels,
            "derive_promotion " + case["name"] + " promoted without adding " + PROMOTABLE,
        )
    else:
        require(
            PROMOTABLE not in labels or PROMOTABLE in case["labels"],
            "derive_promotion " + case["name"] + " added " + PROMOTABLE + " while refusing promotion",
        )
    tokens = tuple(case["expected_reason_tokens"])
    require(
        (len(reasons) == 0) == promotable,
        "derive_promotion "
        + case["name"]
        + " blocking_reasons must be empty exactly when promotable; got "
        + repr(reasons),
    )
    for token in tokens:
        hits = [reason for reason in reasons if token in reason]
        require(
            len(hits) == 1,
            "derive_promotion "
            + case["name"]
            + " must name unmet condition "
            + token
            + " in exactly one blocking reason; got "
            + repr(reasons),
        )
    require(
        len(reasons) == len(tokens),
        "derive_promotion "
        + case["name"]
        + " expected "
        + str(len(tokens))
        + " blocking reasons for "
        + repr(tokens)
        + " got "
        + repr(reasons),
    )
    return verdict


def check_derive_promotion_verdicts(ctx):
    derive_promotion = resolve_attr(ctx["loaded"], "verdict", "derive_promotion")
    for case in ctx["fixture"]["verdict_cases"]:
        _judge_verdict(case, derive_promotion)


def check_derive_promotion_rejects_bad_gates(ctx):
    derive_promotion = resolve_attr(ctx["loaded"], "verdict", "derive_promotion")
    for case in ctx["fixture"]["verdict_invalid_gates"]:
        try:
            observed = derive_promotion(list(case["labels"]), dict(case["gates"]))
        except ValueError:
            continue
        except BaseException as error:  # noqa: BLE001
            fail(
                "derive_promotion "
                + case["name"]
                + " raised "
                + type(error).__name__
                + " instead of ValueError"
            )
        else:
            fail(
                "derive_promotion "
                + case["name"]
                + " accepted a malformed gate mapping and returned promotable="
                + repr(getattr(observed, "promotable", None))
            )


def check_verdict_value_immutable(ctx):
    derive_promotion = resolve_attr(ctx["loaded"], "verdict", "derive_promotion")
    case = ctx["fixture"]["verdict_cases"][0]
    verdict = derive_promotion(list(case["labels"]), dict(case["gates"]))
    for field in VERDICT_FIELDS:
        try:
            setattr(verdict, field, getattr(verdict, field))
        except BaseException:  # noqa: BLE001 - refusing mutation is the requirement
            continue
        else:
            fail("derive_promotion result allows in-place mutation of " + field)
    require(
        isinstance(getattr(verdict, "labels"), tuple),
        "derive_promotion result labels must be an immutable tuple",
    )
    require(
        isinstance(getattr(verdict, "blocking_reasons"), tuple),
        "derive_promotion result blocking_reasons must be an immutable tuple",
    )


# --- the join predicate, shared by the real check and its calibration -------


def _judge_package_exports(package_obj, source_for, subject):
    """Refuse anything that is not a faithful join of the leaf modules.

    ``source_for(origin, name)`` returns the leaf module's own object, so
    "joined" means literally the same object, not an equal restatement.
    """
    for name, origin in PACKAGE_EXPORTS:
        if not hasattr(package_obj, name):
            fail(subject + " does not re-export " + name + " (partial join or renamed export)")
        source = source_for(origin, name)
        if getattr(package_obj, name) is not source:
            fail(
                subject
                + "."
                + name
                + " is not the same object as "
                + PACKAGE
                + "."
                + origin
                + "."
                + name
                + " (restated rather than joined)"
            )


def check_package_exports_joined(ctx):
    loaded = ctx["loaded"]
    package = loaded.get("package")
    if package is None:
        # Unreachable; see resolve_attr.
        raise HarnessError("package __init__ was not executed for this target")
    _judge_package_exports(
        package,
        lambda origin, name: resolve_attr(loaded, origin, name),
        PACKAGE,
    )


def check_package_join_control(ctx):
    """Negative control for the join: prove the join predicate can say no.

    Each fixture-declared control builds a synthetic package namespace from
    the real leaf objects and then breaks it one declared way. The predicate
    must accept the faithful namespace and refuse every broken one; if it
    accepts a broken one, "the join check passed" would mean nothing.

    Every failure in here is a defect in this file or in the fixture, never
    in the candidate. The shapes being judged are built by this file out of
    fixture data; the candidate contributes only the leaf objects, and those
    have their own checks. So a calibration failure raises ``HarnessError``
    and refuses the run. Grading it instead would report "the candidate
    failed" when the truth is "the instrument is broken", which is exactly
    the confusion the two-way classification exists to prevent.
    """
    loaded = ctx["loaded"]

    def source_for(origin, name):
        return resolve_attr(loaded, origin, name)

    def faithful():
        return {name: source_for(origin, name) for name, origin in PACKAGE_EXPORTS}

    try:
        _judge_package_exports(
            SimpleNamespace(**faithful()),
            source_for,
            "join control baseline",
        )
    except ProofFailure as error:
        raise HarnessError(
            "the join predicate refused a faithful namespace built from the "
            "candidate's own leaf objects, so it cannot be trusted to judge "
            "anything: " + str(error)
        )

    for control in ctx["fixture"]["join_negative_controls"]:
        attributes = faithful()
        kind = control["kind"]
        export = control["export"]
        if kind == "missing_export":
            del attributes[export]
        elif kind == "renamed_export":
            attributes[control["renamed_to"]] = attributes.pop(export)
        else:  # restated_export, the only remaining admitted kind
            original = attributes[export]
            restated = _restate(original)
            if restated is original:
                # A "restated" object that is the original object is not a
                # broken shape at all, so the control below would refuse a
                # faithful join and fail a correct candidate. Refusing here
                # keeps that defect from ever reading as a candidate verdict.
                raise HarnessError(
                    "restated join control "
                    + control["name"]
                    + " produced the original object for "
                    + export
                    + " ("
                    + type(original).__name__
                    + "), so it is not a broken shape"
                )
            attributes[export] = restated
        broken = SimpleNamespace(**attributes)
        try:
            _judge_package_exports(broken, source_for, "join control " + control["name"])
        except ProofFailure:
            continue
        raise HarnessError(
            "join negative control "
            + control["name"]
            + " ("
            + kind
            + ") was accepted; the join check cannot detect "
            + kind
        )


class _RestatedTuple(tuple):
    """A tuple that is equal to another tuple but never the same object.

    ``tuple(existing_tuple)`` returns the argument itself, and CPython also
    caches the empty tuple, so neither can express "someone copied this value
    instead of joining it". A subclass instance always allocates.
    """


def _restate(original):
    """Return an equal but genuinely distinct object standing in for a value
    that was copied into the package rather than joined from the leaf module.

    Every branch must return something for which ``restated is not original``
    holds; the caller re-checks that and refuses the run if it does not,
    because a control that silently degrades into the faithful shape would
    fail a correct candidate.
    """
    if isinstance(original, tuple):
        return _RestatedTuple(original)
    if callable(original):
        def restated(*args, **kwargs):
            return original(*args, **kwargs)
        return restated
    # Anything else: a distinct stand-in. It is not equal to the original, but
    # the join predicate judges identity, so distinctness is the whole
    # requirement. Every declared export today is a tuple or a function.
    return SimpleNamespace(value=original)


# --- the import predicate, shared by the real check and its calibration -----


DYNAMIC_IMPORT_NAMES = ("__import__", "importlib")


def _dynamic_import_offence(node):
    """Name the dynamic-import construct this AST node is, or return None.

    Three shapes are refused: a call to ``__import__``, anything reached
    through the ``importlib`` name, and writing to or deleting from
    ``sys.modules``. An honest evidence module has no reason for any of them
    -- it imports what it needs with an import statement, at the top, where a
    reviewer and this file can both see it.

    The limit of this rule, stated plainly: it is a source-text rule, so it
    refuses the obvious spellings and nothing more. Code that assembles the
    same call out of ``getattr`` and string fragments would slip past it, and
    that is accepted. Deliberate evasion is out of scope here (see the
    module docstring); this exists so that an ordinary module cannot reach
    the dynamic import machinery by accident or convenience and end up with
    an unreviewable dependency.
    """
    if isinstance(node, ast.Import):
        for alias in node.names:
            if alias.name.split(".", 1)[0] == "importlib":
                return "importing importlib"
    if isinstance(node, ast.ImportFrom):
        if (node.module or "").split(".", 1)[0] == "importlib":
            return "importing from importlib"
    if isinstance(node, ast.Call):
        function = node.func
        if isinstance(function, ast.Name) and function.id == "__import__":
            return "a call to __import__"
        if isinstance(function, ast.Attribute):
            root = function
            while isinstance(root, ast.Attribute):
                root = root.value
            if isinstance(root, ast.Name) and root.id == "importlib":
                return "a call through importlib"
    if isinstance(node, ast.Name) and node.id == "importlib" and isinstance(node.ctx, ast.Load):
        return "a reference to importlib"
    if isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign, ast.Delete)):
        targets = node.targets if isinstance(node, (ast.Assign, ast.Delete)) else [node.target]
        for target in targets:
            if (
                isinstance(target, ast.Subscript)
                and isinstance(target.value, ast.Attribute)
                and target.value.attr == "modules"
                and isinstance(target.value.value, ast.Name)
                and target.value.value.id == "sys"
            ):
                verb = "deleting from" if isinstance(node, ast.Delete) else "assigning to"
                return verb + " sys.modules"
    return None


def _judge_stdlib_imports(new_top_level, sources, subject):
    """Refuse a runtime or a source file that reaches outside the stdlib.

    ``sources`` is a sequence of ``(filename, source_text)`` pairs. A
    ``SyntaxError`` here is the candidate's defect, not the harness's, so it
    is graded rather than refused.

    Beyond the import names themselves, the source scan refuses the dynamic
    import machinery -- see ``_dynamic_import_offence`` for what that covers
    and, just as importantly, what it does not.
    """
    # sys.stdlib_module_names already carries every private stdlib module the
    # interpreter pulls in (_collections, _functools, _sre and the rest), so
    # there is no need to wave through anything merely because its name starts
    # with an underscore -- and doing so would let a candidate hide a
    # third-party dependency behind a leading underscore.
    allowed_runtime = set(sys.stdlib_module_names) | {PACKAGE}
    offenders = sorted(name for name in new_top_level if name not in allowed_runtime)
    require(
        not offenders,
        subject + ": importing the candidate pulled in non-stdlib modules: " + repr(offenders),
    )
    for filename, source in sources:
        try:
            tree = ast.parse(source, filename=filename)
        except SyntaxError as error:
            fail(subject + ": " + filename + " does not parse: " + str(error))
        for node in ast.walk(tree):
            offence = _dynamic_import_offence(node)
            require(
                offence is None,
                subject + ": " + filename + " uses the dynamic import machinery ("
                + str(offence) + "); an evidence module imports what it needs with "
                "a plain import statement",
            )
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name.split(".", 1)[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level and node.level > 0:
                    continue
                names = [(node.module or "").split(".", 1)[0]]
            for name in names:
                if not name:
                    continue
                require(
                    name in allowed_runtime,
                    subject + ": " + filename + " imports non-stdlib module " + repr(name),
                )
                require(
                    not (name.startswith("qe_") and name != PACKAGE),
                    subject + ": " + filename + " imports first-party package " + repr(name),
                )


def _candidate_source_paths(package_dir):
    """Every .py file the candidate package contains, not only the required
    ones. A helper module nobody declared is still code that ships inside the
    package, so an import hidden there must be judged like any other."""
    found = []
    for root, directory_names, file_names in os.walk(package_dir):
        directory_names[:] = sorted(
            name for name in directory_names if name != "__pycache__"
        )
        for file_name in sorted(file_names):
            if file_name.endswith(".py"):
                path = os.path.join(root, file_name)
                found.append((os.path.relpath(path, package_dir), path))
    return sorted(found)


def _read_candidate_sources(ctx):
    sources = []
    for relative_name, path in _candidate_source_paths(ctx["package_dir"]):
        with open(path, "r", encoding="utf-8") as handle:
            sources.append((relative_name, handle.read()))
    if not sources:
        fail("candidate package contains no Python source at all: " + ctx["package_dir"])
    return sources


def check_stdlib_only_imports(ctx):
    _judge_stdlib_imports(ctx["new_top_level"], _read_candidate_sources(ctx), "candidate")


def check_stdlib_import_control(ctx):
    """Negative control for the stdlib rule: prove the import predicate can
    say no to a runtime that pulled in a third-party module and to a source
    file that imports one, before "no non-stdlib import" means anything.

    Like the join control, nothing here is the candidate's. The inputs are
    literal text from the fixture and a hard-coded clean baseline, so a
    failure means this file's import predicate is broken or the fixture
    declares a control that controls for nothing. Both refuse the run.
    """
    try:
        _judge_stdlib_imports(
            [], [("control_clean.py", "import json\nimport os\n")], "import control baseline"
        )
    except ProofFailure as error:
        raise HarnessError(
            "the import predicate refused a source file that imports only json "
            "and os, so it cannot be trusted to judge anything: " + str(error)
        )

    for control in ctx["fixture"]["stdlib_negative_controls"]:
        if control["kind"] == "runtime_module":
            new_top_level = [control["module"]]
            sources = []
        else:  # source_import, the only remaining admitted kind
            new_top_level = []
            sources = [(control["filename"], control["source"])]
        try:
            _judge_stdlib_imports(new_top_level, sources, "import control " + control["name"])
        except ProofFailure:
            continue
        raise HarnessError(
            "stdlib negative control "
            + control["name"]
            + " ("
            + control["kind"]
            + ") was accepted; the stdlib check cannot detect it"
        )


LABELS_MODULE = "labels"
LABELS_DOTTED = PACKAGE + "." + LABELS_MODULE


def _binds_labels_module(tree):
    """True when the source binds the labels module or names from it.

    The requirement (PRD line 72) is that verdict.py takes the vocabulary from
    the labels module instead of restating it. Python spells that several
    legitimate ways, and refusing a correct candidate for choosing the wrong
    spelling would waste campaign turns on nothing:

        from .labels import EVIDENCE_LABELS      relative, names
        from . import labels                     relative, whole module
        from qe_evidence.labels import ...       absolute, names
        from qe_evidence import labels           absolute, whole module
        import qe_evidence.labels                absolute, dotted
        import qe_evidence.labels as labels      absolute, aliased

    Anything that reaches the labels module counts; the separate restatement
    rule below is what still refuses a copied vocabulary.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level and node.level >= 1:
                # from .labels import X / from ..labels import X
                if module == LABELS_MODULE or module.endswith("." + LABELS_MODULE):
                    return True
                # from . import labels
                if module == "" and any(alias.name == LABELS_MODULE for alias in node.names):
                    return True
                continue
            # from qe_evidence.labels import X
            if module == LABELS_DOTTED:
                return True
            # from qe_evidence import labels
            if module == PACKAGE and any(alias.name == LABELS_MODULE for alias in node.names):
                return True
        elif isinstance(node, ast.Import):
            # import qe_evidence.labels [as labels]
            for alias in node.names:
                if alias.name == LABELS_DOTTED:
                    return True
    return False


def _assigned_names(node):
    """Every plain name this statement binds, however it spells the binding.

    Python has more than one way to write "this name now holds this value",
    and a rule that only understood ``NAME = value`` would miss the two other
    spellings a real module uses:

        EVIDENCE_LABELS: tuple[str, ...] = (...)      an annotated assignment
        EVIDENCE_LABELS, DISQUALIFYING_LABELS = ...   tuple unpacking

    Augmented assignment (``+=``) and walrus bindings are covered too, since
    both bind the name just as firmly. Attribute and subscript targets are
    not names and are deliberately ignored.
    """
    def names_in(target):
        if isinstance(target, ast.Name):
            yield target.id
        elif isinstance(target, (ast.Tuple, ast.List)):
            for element in target.elts:
                for found in names_in(element):
                    yield found
        elif isinstance(target, ast.Starred):
            for found in names_in(target.value):
                yield found

    if isinstance(node, ast.Assign):
        for target in node.targets:
            for found in names_in(target):
                yield found
    elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
        for found in names_in(node.target):
            yield found
    elif isinstance(node, ast.NamedExpr):
        for found in names_in(node.target):
            yield found


def check_verdict_imports_labels(ctx):
    path = os.path.join(ctx["package_dir"], "verdict.py")
    if not os.path.isfile(path):
        fail("verdict.py is missing: " + path)
    with open(path, "r", encoding="utf-8") as handle:
        source = handle.read()
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as error:
        fail("verdict.py does not parse: " + str(error))
    require(
        _binds_labels_module(tree),
        "verdict.py must import the vocabulary from the labels module, not restate it",
    )
    for node in ast.walk(tree):
        for name in _assigned_names(node):
            if name in ("EVIDENCE_LABELS", "DISQUALIFYING_LABELS"):
                fail("verdict.py restates " + name + " instead of importing it")


def check_deterministic_repeat(ctx):
    canonical_labels = resolve_attr(ctx["loaded"], "labels", "canonical_labels")
    merge_labels = resolve_attr(ctx["loaded"], "labels", "merge_labels")
    derive_promotion = resolve_attr(ctx["loaded"], "verdict", "derive_promotion")
    for case in ctx["fixture"]["canonical_labels_cases"]:
        first = canonical_labels(list(case["input"]))
        second = canonical_labels(list(case["input"]))
        require(tuple(first) == tuple(second), "canonical_labels is not deterministic for " + case["name"])
    for case in ctx["fixture"]["merge_labels_cases"]:
        first = merge_labels(list(case["existing"]), list(case["incoming"]))
        second = merge_labels(list(case["existing"]), list(case["incoming"]))
        require(tuple(first) == tuple(second), "merge_labels is not deterministic for " + case["name"])
    for case in ctx["fixture"]["verdict_cases"]:
        first = derive_promotion(list(case["labels"]), dict(case["gates"]))
        second = derive_promotion(list(case["labels"]), dict(case["gates"]))
        require(
            (
                first.promotable == second.promotable
                and tuple(first.labels) == tuple(second.labels)
                and tuple(first.blocking_reasons) == tuple(second.blocking_reasons)
            ),
            "derive_promotion is not deterministic for " + case["name"],
        )


CHECKS = {
    "vocabulary_frozen": check_vocabulary_frozen,
    "promotion_gates_frozen": check_promotion_gates_frozen,
    "canonical_labels_positive": check_canonical_labels_positive,
    "canonical_labels_order_and_type": check_canonical_labels_order_and_type,
    "canonical_labels_rejects_invalid": check_canonical_labels_rejects_invalid,
    "merge_labels_positive": check_merge_labels_positive,
    "merge_labels_preserves_inputs": check_merge_labels_preserves_inputs,
    "derive_promotion_verdicts": check_derive_promotion_verdicts,
    "derive_promotion_rejects_bad_gates": check_derive_promotion_rejects_bad_gates,
    "verdict_value_immutable": check_verdict_value_immutable,
    "package_exports_joined": check_package_exports_joined,
    "package_join_control": check_package_join_control,
    "verdict_imports_labels": check_verdict_imports_labels,
    "stdlib_only_imports": check_stdlib_only_imports,
    "stdlib_import_control": check_stdlib_import_control,
    "deterministic_repeat": check_deterministic_repeat,
}

# Which fixture keys each check reads. Everything named here is validated in
# full before any candidate code runs, so a KeyError, TypeError or IndexError
# raised inside a check can only have come from the candidate.
CHECK_FIXTURE_KEYS = {
    "vocabulary_frozen": ("vocabulary", "disqualifying"),
    "promotion_gates_frozen": ("gates",),
    "canonical_labels_positive": ("vocabulary", "canonical_labels_cases"),
    "canonical_labels_order_and_type": ("vocabulary", "canonical_labels_cases"),
    "canonical_labels_rejects_invalid": ("vocabulary", "canonical_labels_invalid"),
    "merge_labels_positive": ("vocabulary", "merge_labels_cases"),
    "merge_labels_preserves_inputs": ("vocabulary", "merge_labels_cases"),
    "derive_promotion_verdicts": ("vocabulary", "disqualifying", "gates", "verdict_cases"),
    "derive_promotion_rejects_bad_gates": ("gates", "verdict_invalid_gates"),
    "verdict_value_immutable": ("vocabulary", "disqualifying", "gates", "verdict_cases"),
    "package_exports_joined": ("exports",),
    "package_join_control": ("exports", "join_negative_controls"),
    "verdict_imports_labels": (),
    "stdlib_only_imports": (),
    "stdlib_import_control": ("stdlib_negative_controls",),
    "deterministic_repeat": (
        "vocabulary",
        "disqualifying",
        "gates",
        "canonical_labels_cases",
        "merge_labels_cases",
        "verdict_cases",
    ),
}

# Which loaded modules each check needs. Validated against TARGET_REQUIREMENTS
# at load time so ``resolve_attr`` can never meet a module the target never
# asked for.
CHECK_MODULE_KEYS = {
    "vocabulary_frozen": ("labels",),
    "promotion_gates_frozen": ("verdict",),
    "canonical_labels_positive": ("labels",),
    "canonical_labels_order_and_type": ("labels",),
    "canonical_labels_rejects_invalid": ("labels",),
    "merge_labels_positive": ("labels",),
    "merge_labels_preserves_inputs": ("labels",),
    "derive_promotion_verdicts": ("verdict",),
    "derive_promotion_rejects_bad_gates": ("verdict",),
    "verdict_value_immutable": ("verdict",),
    "package_exports_joined": ("package", "labels", "verdict"),
    "package_join_control": ("package", "labels", "verdict"),
    "verdict_imports_labels": ("verdict",),
    "stdlib_only_imports": (),
    "stdlib_import_control": (),
    "deterministic_repeat": ("labels", "verdict"),
}

MODULE_KEY_SOURCE_FILE = {"labels": "labels.py", "verdict": "verdict.py"}


# ---------------------------------------------------------------------------
# proof-evidence v2 declarations and the explicit evidence mapping
#
# The four verify/cases/<name> targets map one-to-one onto the compiled PRD's
# proof ids. Ids pinned from the round-7 compiled plan
# (.archive/l12-live-campaign/124-preview7.stdout.log, data["proofs"]), which
# is the only place these id lists are declared; neither argv nor the
# environment carries them.
#
# Every id below names the exact check ids that prove it, and every mapping
# cites the sentence of docs/plans/2026-09-03-gate3-quant-engine-prd-draft.md
# it is derived from. Where a check appears under both a positive case and a
# negative control, it is because the PRD's own positive-oracle and
# negative-control sentences both name that behaviour.
# ---------------------------------------------------------------------------

CCC_PROOF_EVIDENCE_SCHEMA = "ccc-prd.proof-evidence.v2"

PROOF_DECLARATIONS = {
    "labels": {
        "proofId": "PROOF-EVIDENCE-LABELS",
        "clauses": (
            # PRD line 63: "[AC-REQ-QE-EVIDENCE-LABELS-001] canonical_labels(labels)
            # returns each admitted label once in canonical order and raises
            # ValueError for an unknown, blank, or non-string label." The frozen
            # vocabulary is what "admitted" means (PRD line 39); stdlib-only is
            # the requirement statement's own constraint (PRD line 38).
            ("AC-REQ-QE-EVIDENCE-LABELS-001", (
                "vocabulary_frozen",
                "canonical_labels_positive",
                "canonical_labels_order_and_type",
                "canonical_labels_rejects_invalid",
                "stdlib_only_imports",
            )),
            # PRD line 64: "[AC-REQ-QE-EVIDENCE-LABELS-002] merge_labels(existing,
            # incoming) returns a canonical tuple containing every label of both
            # inputs, so no call can remove, rename, or downgrade a label that
            # either input already carried." Stdlib-only again from PRD line 38.
            ("AC-REQ-QE-EVIDENCE-LABELS-002", (
                "merge_labels_positive",
                "merge_labels_preserves_inputs",
                "stdlib_only_imports",
            )),
        ),
        "positiveCases": (
            # PRD line 68: "Positive oracle: A baseline-owned adapter confirms
            # that canonical_labels and merge_labels return the declared
            # canonical tuple for every admitted label combination the adapter
            # presents."
            ("CASE-EVIDENCE-LABELS", (
                "vocabulary_frozen",
                "canonical_labels_positive",
                "canonical_labels_order_and_type",
                "merge_labels_positive",
                "merge_labels_preserves_inputs",
            )),
        ),
        "negativeControls": (
            # PRD line 68: "Negative control: The adapter refuses any result
            # that drops an input label, admits an unadmitted label, accepts a
            # malformed label, or returns a non-canonical order."
            #   drops an input label      -> canonical_labels_positive (exact
            #                                expected tuple plus its explicit
            #                                per-input "dropped input label"
            #                                assertion), merge_labels_positive
            #                                (exact expected union) and
            #                                merge_labels_preserves_inputs
            #                                (union completeness derived
            #                                independently of the fixture)
            #   admits an unadmitted label,
            #   accepts a malformed label -> canonical_labels_rejects_invalid
            #   non-canonical order       -> canonical_labels_order_and_type
            ("CONTROL-EVIDENCE-LABELS", (
                "canonical_labels_positive",
                "canonical_labels_order_and_type",
                "canonical_labels_rejects_invalid",
                "merge_labels_positive",
                "merge_labels_preserves_inputs",
            )),
        ),
    },
    "verdict": {
        "proofId": "PROOF-EVIDENCE-VERDICT",
        "clauses": (
            # PRD line 76: "[AC-REQ-QE-EVIDENCE-VERDICT-001] derive_promotion(labels,
            # gates) reports promotable true only when the canonical labels include
            # POINT_IN_TIME_PROVIDER, carry no disqualifying label, and every
            # declared promotion gate is present and true; in that case, and only
            # in that case, the returned labels add PROMOTABLE to the canonical
            # input labels." Disqualifying membership comes from the frozen
            # vocabulary (vocabulary_frozen, PRD line 41); "declared promotion
            # gates" from PRD line 42 (promotion_gates_frozen); "built from the
            # frozen labels module" and stdlib-only from the requirement
            # statement, PRD line 72 (verdict_imports_labels,
            # stdlib_only_imports).
            ("AC-REQ-QE-EVIDENCE-VERDICT-001", (
                "vocabulary_frozen",
                "promotion_gates_frozen",
                "derive_promotion_verdicts",
                "verdict_imports_labels",
                "stdlib_only_imports",
                "verdict_value_immutable",
            )),
            # PRD line 77: "[AC-REQ-QE-EVIDENCE-VERDICT-002] derive_promotion(labels,
            # gates) returns blocking_reasons naming each unmet condition in
            # canonical order, empty exactly when promotable is true, and raises
            # ValueError when the gate mapping does not carry exactly the declared
            # gate names."
            # The three constraints in the requirement statement itself (PRD
            # line 72: "one immutable verdict built from the frozen labels
            # module using only the Python standard library") bind every clause
            # of that requirement, not a chosen one. The labels requirement is
            # read the same way -- both its clauses carry stdlib_only_imports --
            # and reading the two requirements differently was a defect.
            ("AC-REQ-QE-EVIDENCE-VERDICT-002", (
                "promotion_gates_frozen",
                "derive_promotion_verdicts",
                "derive_promotion_rejects_bad_gates",
                "verdict_imports_labels",
                "stdlib_only_imports",
                "verdict_value_immutable",
            )),
        ),
        "positiveCases": (
            # PRD line 81: "Positive oracle: A baseline-owned adapter confirms
            # that derive_promotion returns the declared verdict fields for every
            # label and gate state the adapter presents."
            ("CASE-EVIDENCE-VERDICT", (
                "vocabulary_frozen",
                "promotion_gates_frozen",
                "derive_promotion_verdicts",
                "verdict_imports_labels",
            )),
        ),
        "negativeControls": (
            # PRD line 81: "Negative control: The adapter refuses a verdict that
            # promotes without point-in-time evidence, promotes while a
            # disqualifying label is present, promotes with an unmet or misnamed
            # gate, or omits a blocking reason for an unmet condition."
            # derive_promotion_verdicts carries the refused fixture cases and
            # asserts every unmet condition is named exactly once;
            # derive_promotion_rejects_bad_gates carries the misnamed-gate
            # mappings; vocabulary_frozen is what makes "a disqualifying label"
            # mean anything, since the frozen vocabulary is where that set is
            # defined.
            # verdict_value_immutable is deliberately NOT here. Line 81's
            # control sentence does not mention mutability, and immutability is
            # a requirement-statement constraint (PRD line 72) that now binds
            # both verdict clauses instead. A control id that reads false for a
            # reason its own sentence never names misattributes the evidence.
            ("CONTROL-EVIDENCE-VERDICT", (
                "derive_promotion_verdicts",
                "derive_promotion_rejects_bad_gates",
                "vocabulary_frozen",
            )),
        ),
    },
    "candidate": {
        "proofId": "PROOF-EVIDENCE-CANDIDATE",
        "clauses": (
            # PRD line 89: "[AC-REQ-QE-EVIDENCE-INTEGRATE-001] Importing the
            # qe_evidence package exposes EVIDENCE_LABELS, DISQUALIFYING_LABELS,
            # canonical_labels, merge_labels, PROMOTION_GATES, and
            # derive_promotion from one joined commit, with no import outside the
            # Python standard library and no change to the label or verdict
            # behavior proved by the leaf tasks." One clause, so it carries every
            # declared check: the join, its calibration, the stdlib rule and its
            # calibration, and the leaf-behaviour drift checks.
            # "no change to the label or verdict behavior proved by the leaf
            # tasks" is half the clause, so every leaf check the leaf proofs
            # declare is re-run here and mapped: the frozen vocabulary and gate
            # set, canonical order, union completeness, verdict immutability,
            # and both leaf refusal behaviours. A join cannot be admitted while
            # any leaf behaviour drifted.
            ("AC-REQ-QE-EVIDENCE-INTEGRATE-001", (
                "package_exports_joined",
                "package_join_control",
                "stdlib_only_imports",
                "stdlib_import_control",
                "verdict_imports_labels",
                "vocabulary_frozen",
                "promotion_gates_frozen",
                "canonical_labels_positive",
                "canonical_labels_order_and_type",
                "canonical_labels_rejects_invalid",
                "merge_labels_positive",
                "merge_labels_preserves_inputs",
                "derive_promotion_verdicts",
                "derive_promotion_rejects_bad_gates",
                "verdict_value_immutable",
            )),
        ),
        "positiveCases": (
            # PRD line 93: "Positive oracle: A baseline-owned adapter confirms
            # that the joined package re-exports the declared public surface and
            # reproduces the leaf label and verdict behavior it presents."
            ("CASE-EVIDENCE-CANDIDATE", (
                "package_exports_joined",
                "vocabulary_frozen",
                "promotion_gates_frozen",
                "canonical_labels_positive",
                "canonical_labels_order_and_type",
                "merge_labels_positive",
                "merge_labels_preserves_inputs",
                "derive_promotion_verdicts",
                "verdict_imports_labels",
            )),
        ),
        "negativeControls": (
            # PRD line 93: "Negative control: The adapter refuses a partial
            # join, a missing or renamed export [package_exports_joined is the
            # refusal against the real package, package_join_control proves that
            # refusal is real], an import outside the Python standard library
            # [stdlib_only_imports, calibrated by stdlib_import_control], or any
            # drift in the label and verdict behavior already established by the
            # leaf tasks." That last clause imports the leaf proofs' own
            # controls wholesale: a dropped label, an unadmitted or malformed
            # label, a non-canonical order, a mutated vocabulary or gate set, a
            # promotable result without every precondition, a malformed gate
            # mapping, and a mutable verdict value.
            # "any drift in the label and verdict behavior already established
            # by the leaf tasks" is every check the leaf clauses carry, and that
            # includes verdict_imports_labels: the leaf tasks established that
            # the verdict is built from the frozen labels module, so a join that
            # broke that link is drift like any other.
            ("CONTROL-EVIDENCE-CANDIDATE", (
                "package_exports_joined",
                "package_join_control",
                "stdlib_only_imports",
                "stdlib_import_control",
                "verdict_imports_labels",
                "vocabulary_frozen",
                "promotion_gates_frozen",
                "canonical_labels_positive",
                "canonical_labels_order_and_type",
                "canonical_labels_rejects_invalid",
                "merge_labels_positive",
                "merge_labels_preserves_inputs",
                "derive_promotion_verdicts",
                "derive_promotion_rejects_bad_gates",
                "verdict_value_immutable",
            )),
        ),
    },
    "integrated": {
        "proofId": "PROOF-EVIDENCE-INTEGRATED",
        "clauses": (
            # Same clause text as the candidate proof (PRD line 89), proved on
            # the joined commit. A shared id may never be proved on less at a
            # later phase, so this must map at least every check the candidate
            # proof maps to the same id; validate_phase_declarations enforces
            # that rather than trusting this comment. Determinism is added on
            # top, because
            # the final proof is where "reproducible from the inputs alone"
            # (PRD line 45) has to hold for the joined surface.
            ("AC-REQ-QE-EVIDENCE-INTEGRATE-001", (
                "package_exports_joined",
                "package_join_control",
                "stdlib_only_imports",
                "stdlib_import_control",
                "verdict_imports_labels",
                "vocabulary_frozen",
                "promotion_gates_frozen",
                "canonical_labels_positive",
                "canonical_labels_order_and_type",
                "canonical_labels_rejects_invalid",
                "merge_labels_positive",
                "merge_labels_preserves_inputs",
                "derive_promotion_verdicts",
                "derive_promotion_rejects_bad_gates",
                "verdict_value_immutable",
                "deterministic_repeat",
            )),
            # PRD line 63, re-proved on the join. deterministic_repeat is here
            # because PRD line 45 ("two calls with equal inputs always return
            # equal results") is what makes "returns each admitted label once in
            # canonical order" a property of the function rather than of one call.
            ("AC-REQ-QE-EVIDENCE-LABELS-001", (
                "vocabulary_frozen",
                "canonical_labels_positive",
                "canonical_labels_order_and_type",
                "canonical_labels_rejects_invalid",
                "stdlib_only_imports",
                "deterministic_repeat",
            )),
            # PRD line 64, re-proved on the join.
            ("AC-REQ-QE-EVIDENCE-LABELS-002", (
                "merge_labels_positive",
                "merge_labels_preserves_inputs",
                "stdlib_only_imports",
                "deterministic_repeat",
            )),
            # PRD line 76, re-proved on the join.
            ("AC-REQ-QE-EVIDENCE-VERDICT-001", (
                "vocabulary_frozen",
                "promotion_gates_frozen",
                "derive_promotion_verdicts",
                "verdict_imports_labels",
                "stdlib_only_imports",
                "verdict_value_immutable",
                "deterministic_repeat",
            )),
            # PRD line 77, re-proved on the join.
            ("AC-REQ-QE-EVIDENCE-VERDICT-002", (
                "promotion_gates_frozen",
                "derive_promotion_verdicts",
                "derive_promotion_rejects_bad_gates",
                "verdict_imports_labels",
                "stdlib_only_imports",
                "verdict_value_immutable",
                "deterministic_repeat",
            )),
        ),
        "positiveCases": (
            # PRD line 97: "Positive oracle: The joined src/qe_evidence package
            # satisfies the complete label and verdict contract from one commit
            # with no import outside the Python standard library."
            ("CASE-EVIDENCE-INTEGRATED", (
                "vocabulary_frozen",
                "promotion_gates_frozen",
                "canonical_labels_positive",
                "canonical_labels_order_and_type",
                "merge_labels_positive",
                "merge_labels_preserves_inputs",
                "derive_promotion_verdicts",
                "package_exports_joined",
                "verdict_imports_labels",
                "stdlib_only_imports",
                "deterministic_repeat",
            )),
        ),
        "negativeControls": (
            # PRD line 97: "Negative control: A partial join
            # [package_exports_joined, calibrated by package_join_control], a
            # mutated label vocabulary [vocabulary_frozen,
            # canonical_labels_rejects_invalid], a mutable verdict value
            # [verdict_value_immutable], or a promotable result reachable without
            # every declared precondition [derive_promotion_verdicts' refused
            # cases, derive_promotion_rejects_bad_gates, and
            # promotion_gates_frozen, which is what "declared precondition"
            # refers to] is rejected."
            # This sentence, and only this sentence. The previous pass also
            # carried the stdlib rule and the four leaf positive checks in here,
            # reasoning that the last proof should not be a weaker instrument
            # than the one before it. That reasoning is right about clauses and
            # wrong about controls: line 97 enumerates four refusals and imports
            # is not one of them, so a false reading here would have pointed at
            # a control the PRD never asked this id to establish. Nothing is
            # lost -- every check removed is still mapped at this phase through
            # the five clauses the integrated proof re-proves.
            ("CONTROL-EVIDENCE-INTEGRATED", (
                "package_exports_joined",
                "package_join_control",
                "vocabulary_frozen",
                "canonical_labels_rejects_invalid",
                "verdict_value_immutable",
                "derive_promotion_verdicts",
                "derive_promotion_rejects_bad_gates",
                "promotion_gates_frozen",
            )),
        ),
    },
}

DECLARATION_SECTIONS = (
    ("clauses", "clauseId"),
    ("positiveCases", "caseId"),
    ("negativeControls", "controlId"),
)

# Campaign order of the four proofs.
PHASE_ORDER = ("labels", "verdict", "candidate", "integrated")

# What each phase must declare, read straight off the PRD's own "Expected
# proof" paragraphs rather than inferred from the mapping table above. The
# clause ids are the PRD's bracketed labels, quoted verbatim. The case and
# control ids are this campaign's names for the single positive oracle and
# the single negative control each of those paragraphs declares -- the PRD
# says "Positive oracle: ..." and "Negative control: ..." once each per
# proof, and these are what those became.
#
# This table is deliberately a second, independent statement of the same
# facts. The mapping table above says which checks establish an id; this one
# says which ids have to exist at all. A phase that quietly stopped declaring
# a clause would satisfy the first table trivially -- there would be nothing
# left to map -- and only a separate statement of what must be present can
# catch that.
PHASE_REQUIREMENTS = {
    # PRD line 68: "the verifier command task verify:evidence-labels
    # establishes AC-REQ-QE-EVIDENCE-LABELS-001 and
    # AC-REQ-QE-EVIDENCE-LABELS-002", with one positive oracle and one
    # negative control.
    "labels": {
        "clauses": ("AC-REQ-QE-EVIDENCE-LABELS-001", "AC-REQ-QE-EVIDENCE-LABELS-002"),
        "positiveCases": ("CASE-EVIDENCE-LABELS",),
        "negativeControls": ("CONTROL-EVIDENCE-LABELS",),
    },
    # PRD line 81: "task verify:evidence-verdict establishes
    # AC-REQ-QE-EVIDENCE-VERDICT-001 and AC-REQ-QE-EVIDENCE-VERDICT-002",
    # again one oracle and one control.
    "verdict": {
        "clauses": ("AC-REQ-QE-EVIDENCE-VERDICT-001", "AC-REQ-QE-EVIDENCE-VERDICT-002"),
        "positiveCases": ("CASE-EVIDENCE-VERDICT",),
        "negativeControls": ("CONTROL-EVIDENCE-VERDICT",),
    },
    # PRD line 93: "task verify:evidence-candidate establishes
    # AC-REQ-QE-EVIDENCE-INTEGRATE-001", one clause, one oracle, one control.
    "candidate": {
        "clauses": ("AC-REQ-QE-EVIDENCE-INTEGRATE-001",),
        "positiveCases": ("CASE-EVIDENCE-CANDIDATE",),
        "negativeControls": ("CONTROL-EVIDENCE-CANDIDATE",),
    },
    # PRD line 97: "The final integrated proof uses the verifier command task
    # verify:evidence-integrated and proves every admitted clause on the
    # joined candidate commit." Every admitted clause is all five of them.
    "integrated": {
        "clauses": (
            "AC-REQ-QE-EVIDENCE-INTEGRATE-001",
            "AC-REQ-QE-EVIDENCE-LABELS-001",
            "AC-REQ-QE-EVIDENCE-LABELS-002",
            "AC-REQ-QE-EVIDENCE-VERDICT-001",
            "AC-REQ-QE-EVIDENCE-VERDICT-002",
        ),
        "positiveCases": ("CASE-EVIDENCE-INTEGRATED",),
        "negativeControls": ("CONTROL-EVIDENCE-INTEGRATED",),
    },
}

# PRD line 89, the integrate clause: "...and no change to the label or verdict
# behavior proved by the leaf tasks." Half of that sentence is about the join
# and half is about the leaf behaviour, so any phase that declares this clause
# has to carry the evidence the leaf phases used for their own clauses. Naming
# the leaf phases here rather than deriving them keeps the requirement
# readable and keeps it a statement about the PRD, not about the table.
INTEGRATE_CLAUSE = "AC-REQ-QE-EVIDENCE-INTEGRATE-001"
INTEGRATE_LEAF_PHASES = ("labels", "verdict")


def _declared_ids(declaration, section):
    return tuple(identifier for identifier, _ in declaration[section])


def _declared_mapping(declaration):
    mapping = {}
    for section, _ in DECLARATION_SECTIONS:
        for identifier, check_ids in declaration[section]:
            mapping[identifier] = frozenset(check_ids)
    return mapping


def validate_phase_declarations():
    """Refuse the declaration table unless every phase declares what the PRD
    says it establishes, and no later phase proves a shared id on less.

    Three separate rules, because the earlier single rule -- "a clause may not
    drop checks between phases" -- turned out to be satisfied by doing
    nothing. It compared clauses by id, and the candidate phase shares no
    clause id with either leaf phase, so there was nothing for it to compare.
    It also said nothing about a phase that simply stopped declaring a clause,
    a positive case or a negative control, which is the easier way to weaken a
    proof and the harder one to notice.

        1. Required ids. Each phase declares exactly the clause ids, case ids
           and control ids the PRD's expected-proof paragraph names for it.
           Missing one is a refusal; so is declaring an extra one, because an
           id nobody asked for is evidence nobody will read.

        2. Shared ids never weaken. For any id declared by two phases, the
           later phase must map at least every check the earlier one mapped.

        3. The integrate clause carries the leaf evidence. Wherever
           AC-REQ-QE-EVIDENCE-INTEGRATE-001 is declared it must map at least
           every check the labels and verdict phases map to their own clauses,
           because its text requires that the join changed no leaf behaviour.

    All static: this runs on every dispatch and judges all four phases, not
    only the one being run. Every failure is a defect in this file, so every
    one raises ``HarnessError`` and refuses with no envelope.
    """
    for target in PHASE_ORDER:
        if target not in PROOF_DECLARATIONS:
            raise HarnessError("PHASE_ORDER names an undeclared target: " + target)
        if target not in PHASE_REQUIREMENTS:
            raise HarnessError("PHASE_ORDER names a target with no PRD requirement: " + target)

    # --- rule 1 ------------------------------------------------------------
    for target in PHASE_ORDER:
        declaration = PROOF_DECLARATIONS[target]
        required = PHASE_REQUIREMENTS[target]
        for section, _ in DECLARATION_SECTIONS:
            declared = set(_declared_ids(declaration, section))
            expected = set(required[section])
            missing = sorted(expected - declared)
            if missing:
                raise HarnessError(
                    "the " + target + " proof does not declare the " + section
                    + " the PRD says it establishes; missing " + repr(missing)
                )
            extra = sorted(declared - expected)
            if extra:
                raise HarnessError(
                    "the " + target + " proof declares " + section
                    + " the PRD does not name for it: " + repr(extra)
                )

    # --- rule 2 ------------------------------------------------------------
    seen = {}
    for target in PHASE_ORDER:
        mapping = _declared_mapping(PROOF_DECLARATIONS[target])
        for identifier, check_ids in mapping.items():
            earlier = seen.get(identifier)
            if earlier is not None:
                earlier_target, earlier_checks = earlier
                dropped = sorted(earlier_checks - check_ids)
                if dropped:
                    raise HarnessError(
                        identifier + " is proved on less evidence at phase " + target
                        + " than at " + earlier_target + "; it drops " + repr(dropped)
                    )
            seen[identifier] = (target, check_ids)

    # --- rule 3 ------------------------------------------------------------
    leaf_checks = set()
    for phase in INTEGRATE_LEAF_PHASES:
        for _, check_ids in PROOF_DECLARATIONS[phase]["clauses"]:
            leaf_checks |= set(check_ids)
    for target in PHASE_ORDER:
        mapping = _declared_mapping(PROOF_DECLARATIONS[target])
        if INTEGRATE_CLAUSE not in mapping:
            continue
        missing = sorted(leaf_checks - mapping[INTEGRATE_CLAUSE])
        if missing:
            raise HarnessError(
                INTEGRATE_CLAUSE + " at phase " + target
                + " requires that the join changed no leaf behaviour, but it does"
                " not carry the leaf evidence: missing " + repr(missing)
            )


# ---------------------------------------------------------------------------
# argument handling
# ---------------------------------------------------------------------------


def parse_args(argv):
    if len(argv) != 2 or argv[0] != "--target":
        raise HarnessError(
            "usage: python3 verify/qe_evidence_adapter.py --target verify/cases/<name>"
        )
    target = argv[1]
    if os.path.isabs(target) or ".." in target.replace("\\", "/").split("/"):
        raise HarnessError("--target must be a repository-relative path: " + target)
    normalised = os.path.normpath(target)
    if os.path.dirname(normalised) != TARGET_PARENT:
        raise HarnessError("--target must live under " + TARGET_PARENT + ": " + target)
    if not os.path.isdir(normalised):
        raise HarnessError("--target directory does not exist: " + normalised)
    return normalised


# ---------------------------------------------------------------------------
# fixture loading and full-shape validation
#
# Everything here raises HarnessError. A fixture defect is never a candidate
# verdict, and after this stage no fixture access inside a check can raise.
# ---------------------------------------------------------------------------


def _bad(where, message):
    raise HarnessError("fixture " + where + " " + message)


def _need(mapping, key, where):
    if not isinstance(mapping, dict) or key not in mapping:
        _bad(where, "is missing required key " + repr(key))
    return mapping[key]


def _need_str(mapping, key, where):
    value = _need(mapping, key, where)
    if not isinstance(value, str) or not value:
        _bad(where + "." + key, "must be a non-empty string")
    return value


def _need_bool(mapping, key, where):
    value = _need(mapping, key, where)
    if not isinstance(value, bool):
        _bad(where + "." + key, "must be a boolean")
    return value


def _need_str_list(mapping, key, where, allow_empty=True):
    value = _need(mapping, key, where)
    if not isinstance(value, list):
        _bad(where + "." + key, "must be a list")
    if not allow_empty and not value:
        _bad(where + "." + key, "must not be empty")
    for entry in value:
        if not isinstance(entry, str):
            _bad(where + "." + key, "must contain only strings, got " + repr(entry))
    return value


def _need_case_list(fixture, key, where, minimum=1):
    value = _need(fixture, key, where)
    if not isinstance(value, list) or len(value) < minimum:
        _bad(where + "." + key, "must be a list of at least " + str(minimum) + " case objects")
    names = set()
    for index, case in enumerate(value):
        location = where + "." + key + "[" + str(index) + "]"
        if not isinstance(case, dict):
            _bad(location, "must be an object")
        name = _need_str(case, "name", location)
        if name in names:
            _bad(location, "repeats the case name " + repr(name))
        names.add(name)
    return value


def _validate_vocabulary(fixture, where):
    vocabulary = _need_str_list(fixture, "vocabulary", where, allow_empty=False)
    disqualifying = _need_str_list(fixture, "disqualifying", where, allow_empty=False)
    if list(vocabulary) != sorted(set(vocabulary)):
        _bad(where + ".vocabulary", "must be unique and in ascending order")
    if list(disqualifying) != sorted(set(disqualifying)):
        _bad(where + ".disqualifying", "must be unique and in ascending order")
    unknown = sorted(set(disqualifying) - set(vocabulary))
    if unknown:
        _bad(where + ".disqualifying", "names labels outside the vocabulary: " + repr(unknown))
    for required in (POINT_IN_TIME, PROMOTABLE):
        if required not in vocabulary:
            _bad(where + ".vocabulary", "must admit " + required)
    return vocabulary, disqualifying


def _validate_gates(fixture, where):
    gates = _need_str_list(fixture, "gates", where, allow_empty=False)
    if list(gates) != sorted(set(gates)):
        _bad(where + ".gates", "must be unique and in ascending order")
    return gates


def _validate_canonical_cases(fixture, where):
    vocabulary = set(_need_str_list(fixture, "vocabulary", where, allow_empty=False))
    for index, case in enumerate(_need_case_list(fixture, "canonical_labels_cases", where)):
        location = where + ".canonical_labels_cases[" + str(index) + "]"
        inputs = _need_str_list(case, "input", location)
        expected = _need_str_list(case, "expected", location)
        outside = sorted(set(inputs) - vocabulary)
        if outside:
            _bad(location + ".input", "uses labels outside the vocabulary: " + repr(outside))
        derived = sorted(set(inputs))
        if list(expected) != derived:
            _bad(
                location + ".expected",
                "is not the canonical form of its own input: expected "
                + repr(derived)
                + " got "
                + repr(list(expected)),
            )


def _validate_invalid_label_cases(fixture, where):
    vocabulary = set(_need_str_list(fixture, "vocabulary", where, allow_empty=False))
    for index, case in enumerate(_need_case_list(fixture, "canonical_labels_invalid", where)):
        location = where + ".canonical_labels_invalid[" + str(index) + "]"
        inputs = _need(case, "input", location)
        if not isinstance(inputs, list):
            _bad(location + ".input", "must be a list")
        offending = [
            entry
            for entry in inputs
            if not isinstance(entry, str) or not entry.strip() or entry not in vocabulary
        ]
        if not offending:
            # Without this, a "negative control" could be a list of perfectly
            # admitted labels, and a candidate that never validates anything
            # would still be recorded as refusing bad input.
            _bad(
                location + ".input",
                "carries no unadmitted, blank or non-string label, so it is not a negative control",
            )


def _validate_merge_cases(fixture, where):
    vocabulary = set(_need_str_list(fixture, "vocabulary", where, allow_empty=False))
    for index, case in enumerate(_need_case_list(fixture, "merge_labels_cases", where)):
        location = where + ".merge_labels_cases[" + str(index) + "]"
        existing = _need_str_list(case, "existing", location)
        incoming = _need_str_list(case, "incoming", location)
        expected = _need_str_list(case, "expected", location)
        outside = sorted((set(existing) | set(incoming)) - vocabulary)
        if outside:
            _bad(location, "uses labels outside the vocabulary: " + repr(outside))
        derived = sorted(set(existing) | set(incoming))
        if list(expected) != derived:
            _bad(
                location + ".expected",
                "is not the canonical union of its own inputs: expected "
                + repr(derived)
                + " got "
                + repr(list(expected)),
            )


def _validate_verdict_cases(fixture, where):
    vocabulary, disqualifying = _validate_vocabulary(fixture, where)
    gates = _validate_gates(fixture, where)
    seen_promotable = False
    seen_refused = False
    for index, case in enumerate(_need_case_list(fixture, "verdict_cases", where)):
        location = where + ".verdict_cases[" + str(index) + "]"
        labels = _need_str_list(case, "labels", location)
        outside = sorted(set(labels) - set(vocabulary))
        if outside:
            _bad(location + ".labels", "uses labels outside the vocabulary: " + repr(outside))
        case_gates = _need(case, "gates", location)
        if not isinstance(case_gates, dict) or set(case_gates) != set(gates):
            _bad(
                location + ".gates",
                "must carry exactly the declared gate names, so a valid case can never"
                " trip the malformed-gate rule",
            )
        for gate_name, gate_value in case_gates.items():
            if not isinstance(gate_value, bool):
                _bad(location + ".gates." + gate_name, "must be a boolean")
        expected_promotable = _need_bool(case, "expected_promotable", location)
        expected_labels = _need_str_list(case, "expected_labels", location)
        expected_tokens = _need_str_list(case, "expected_reason_tokens", location)

        # Re-derive the PRD's own rule (lines 91-92) from the case's inputs, so
        # a fixture can never declare an expectation the requirement does not
        # imply -- the oracle has to agree with the requirement, not just with
        # whatever the candidate happens to do.
        canonical = tuple(sorted(set(labels)))
        derived_tokens = set()
        if POINT_IN_TIME not in canonical:
            derived_tokens.add(POINT_IN_TIME)
        for label in canonical:
            if label in disqualifying:
                derived_tokens.add(label)
        for gate_name in gates:
            if not case_gates[gate_name]:
                derived_tokens.add(gate_name)
        derived_promotable = not derived_tokens
        derived_labels = (
            tuple(sorted(set(canonical) | {PROMOTABLE})) if derived_promotable else canonical
        )
        if derived_promotable != expected_promotable:
            _bad(
                location + ".expected_promotable",
                "disagrees with the requirement: derived " + repr(derived_promotable),
            )
        if sorted(expected_tokens) != sorted(derived_tokens):
            _bad(
                location + ".expected_reason_tokens",
                "disagrees with the requirement: derived " + repr(sorted(derived_tokens)),
            )
        if tuple(expected_labels) != derived_labels:
            _bad(
                location + ".expected_labels",
                "disagrees with the requirement: derived " + repr(list(derived_labels)),
            )
        seen_promotable = seen_promotable or derived_promotable
        seen_refused = seen_refused or not derived_promotable
    if not seen_promotable:
        _bad(where + ".verdict_cases", "declares no promotable case")
    if not seen_refused:
        _bad(where + ".verdict_cases", "declares no refused case")


def _validate_invalid_gate_cases(fixture, where):
    gates = _validate_gates(fixture, where)
    for index, case in enumerate(_need_case_list(fixture, "verdict_invalid_gates", where)):
        location = where + ".verdict_invalid_gates[" + str(index) + "]"
        _need_str_list(case, "labels", location)
        case_gates = _need(case, "gates", location)
        if not isinstance(case_gates, dict):
            _bad(location + ".gates", "must be an object")
        if set(case_gates) == set(gates):
            # A "malformed" mapping that carries exactly the declared names is
            # well formed, so this control would pass against a candidate that
            # never validates gate names at all.
            _bad(
                location + ".gates",
                "carries exactly the declared gate names, so it is not a negative control",
            )


def _validate_exports(fixture, where):
    exports = _need(fixture, "exports", where)
    if not isinstance(exports, dict):
        _bad(where + ".exports", "must be an object")
    declared = _need_str_list(exports, "package", where + ".exports", allow_empty=False)
    expected = [name for name, _ in PACKAGE_EXPORTS]
    if list(declared) != expected:
        # Fixture drift from the adapter's own export contract is a harness
        # defect, not a candidate verdict.
        _bad(
            where + ".exports.package",
            "drifted from the adapter contract: expected " + repr(expected) + " got " + repr(list(declared)),
        )


JOIN_CONTROL_KINDS = ("missing_export", "renamed_export", "restated_export")

# Whether each declared export is a callable or a plain value. A "restated"
# control has to cover both, because copying a function and copying a tuple
# are different mistakes and, in Python, are caught by different code paths.
PACKAGE_EXPORT_KINDS = {
    "EVIDENCE_LABELS": "value",
    "DISQUALIFYING_LABELS": "value",
    "canonical_labels": "callable",
    "merge_labels": "callable",
    "PROMOTION_GATES": "value",
    "derive_promotion": "callable",
}


def _validate_join_controls(fixture, where):
    _validate_exports(fixture, where)
    export_names = {name for name, _ in PACKAGE_EXPORTS}
    kinds = set()
    restated_export_kinds = set()
    for index, control in enumerate(_need_case_list(fixture, "join_negative_controls", where, minimum=4)):
        location = where + ".join_negative_controls[" + str(index) + "]"
        kind = _need_str(control, "kind", location)
        if kind not in JOIN_CONTROL_KINDS:
            _bad(location + ".kind", "must be one of " + repr(list(JOIN_CONTROL_KINDS)))
        export = _need_str(control, "export", location)
        if export not in export_names:
            _bad(location + ".export", "must name a declared package export: " + repr(export))
        if kind == "renamed_export":
            renamed_to = _need_str(control, "renamed_to", location)
            if renamed_to == export or renamed_to in export_names:
                _bad(
                    location + ".renamed_to",
                    "must be a name the package contract does not declare",
                )
        if kind == "restated_export":
            restated_export_kinds.add(PACKAGE_EXPORT_KINDS[export])
        kinds.add(kind)
    missing = sorted(set(JOIN_CONTROL_KINDS) - kinds)
    if missing:
        _bad(
            where + ".join_negative_controls",
            "does not cover every join failure the PRD names as a control: " + repr(missing),
        )
    missing_restated = sorted({"value", "callable"} - restated_export_kinds)
    if missing_restated:
        _bad(
            where + ".join_negative_controls",
            "declares no restated_export control for a "
            + " or ".join(missing_restated)
            + " export; copying a function and copying a tuple fail differently",
        )


STDLIB_CONTROL_KINDS = ("runtime_module", "source_import")


def _validate_stdlib_controls(fixture, where):
    allowed = set(sys.stdlib_module_names) | {PACKAGE}
    kinds = set()
    for index, control in enumerate(_need_case_list(fixture, "stdlib_negative_controls", where, minimum=2)):
        location = where + ".stdlib_negative_controls[" + str(index) + "]"
        kind = _need_str(control, "kind", location)
        if kind not in STDLIB_CONTROL_KINDS:
            _bad(location + ".kind", "must be one of " + repr(list(STDLIB_CONTROL_KINDS)))
        if kind == "runtime_module":
            module = _need_str(control, "module", location)
            # The judge stopped excusing leading-underscore names in the
            # fourth pass, because sys.stdlib_module_names already carries
            # every private stdlib module. This validator has to use the same
            # rule, or it would reject `_sneaky_vendor` as "not a control"
            # while the judge treats it as exactly the offence a control
            # should name.
            if module in allowed:
                _bad(
                    location + ".module",
                    "names something the stdlib rule already allows, so it is not a control",
                )
        else:
            _need_str(control, "filename", location)
            source = _need_str(control, "source", location)
            try:
                ast.parse(source, filename=control["filename"])
            except SyntaxError as error:
                _bad(location + ".source", "does not parse: " + str(error))
        kinds.add(kind)
    missing = sorted(set(STDLIB_CONTROL_KINDS) - kinds)
    if missing:
        _bad(
            where + ".stdlib_negative_controls",
            "does not cover every import failure the stdlib rule must catch: " + repr(missing),
        )


FIXTURE_KEY_VALIDATORS = {
    "vocabulary": _validate_vocabulary,
    "disqualifying": _validate_vocabulary,
    "gates": _validate_gates,
    "canonical_labels_cases": _validate_canonical_cases,
    "canonical_labels_invalid": _validate_invalid_label_cases,
    "merge_labels_cases": _validate_merge_cases,
    "verdict_cases": _validate_verdict_cases,
    "verdict_invalid_gates": _validate_invalid_gate_cases,
    "exports": _validate_exports,
    "join_negative_controls": _validate_join_controls,
    "stdlib_negative_controls": _validate_stdlib_controls,
}


def load_fixture(target_dir):
    path = os.path.join(target_dir, CASES_FILENAME)
    if not os.path.isfile(path):
        raise HarnessError("fixture is missing: " + path)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            fixture = json.load(handle)
    except OSError as error:
        raise HarnessError("fixture could not be read: " + path + ": " + str(error)) from error
    except UnicodeDecodeError as error:
        raise HarnessError("fixture is not valid UTF-8: " + path + ": " + str(error)) from error
    except ValueError as error:
        raise HarnessError("fixture is not valid JSON: " + path + ": " + str(error)) from error
    if not isinstance(fixture, dict):
        raise HarnessError("fixture must be a JSON object: " + path)
    if fixture.get("schema") != FIXTURE_SCHEMA:
        raise HarnessError("fixture schema must be " + FIXTURE_SCHEMA + ": " + path)
    name = os.path.basename(target_dir)
    if fixture.get("target") != name:
        raise HarnessError("fixture target does not match its directory: " + path)
    if name not in TARGET_REQUIREMENTS or name not in PROOF_DECLARATIONS:
        raise HarnessError("unknown proof target: " + name)

    checks = fixture.get("checks")
    if not isinstance(checks, list) or not checks:
        raise HarnessError("fixture must declare a non-empty checks list: " + path)
    for check_id in checks:
        if not isinstance(check_id, str) or check_id not in CHECKS:
            raise HarnessError("fixture declares an unknown check id: " + repr(check_id))
    if len(set(checks)) != len(checks):
        raise HarnessError("fixture declares a duplicate check id: " + path)

    validate_phase_declarations()
    validate_declared_checks(name, checks)

    # Validate every fixture key any declared check will read, so no fixture
    # access inside a check can raise.
    needed = set()
    for check_id in checks:
        needed.update(CHECK_FIXTURE_KEYS[check_id])
    for key in sorted(needed):
        FIXTURE_KEY_VALIDATORS[key](fixture, path)
    return name, fixture


def validate_declared_checks(name, checks):
    """Prove the evidence mapping is total, before any check runs.

    Every declared id must map to at least one check the fixture declares,
    every fixture check must prove at least one declared id, and every check
    must have the candidate modules it needs for this target. Any of these
    failing means the envelope could not honestly report what it claims, so
    all of them are refusals.
    """
    declaration = PROOF_DECLARATIONS[name]
    declared = set(checks)
    mapped = set()
    seen_ids = set()
    for section, id_key in DECLARATION_SECTIONS:
        entries = declaration[section]
        if not entries:
            raise HarnessError(name + " declares no " + section)
        for entry_id, check_ids in entries:
            if entry_id in seen_ids:
                raise HarnessError("declared id appears twice: " + entry_id)
            seen_ids.add(entry_id)
            if not check_ids:
                raise HarnessError(
                    "declared " + id_key + " " + entry_id + " maps to no check, so it could only pass vacuously"
                )
            missing = sorted(set(check_ids) - declared)
            if missing:
                raise HarnessError(
                    "declared "
                    + id_key
                    + " "
                    + entry_id
                    + " maps to checks the "
                    + name
                    + " fixture does not declare: "
                    + repr(missing)
                )
            mapped.update(check_ids)
    unmapped = sorted(declared - mapped)
    if unmapped:
        raise HarnessError(
            "the " + name + " fixture declares checks that prove no declared id: " + repr(unmapped)
        )

    required_files, execute_init = TARGET_REQUIREMENTS[name]
    for check_id in sorted(declared):
        for module_key in CHECK_MODULE_KEYS[check_id]:
            if module_key == "package":
                if not execute_init:
                    raise HarnessError(
                        "check "
                        + check_id
                        + " needs the joined package but target "
                        + name
                        + " does not execute __init__"
                    )
                continue
            source_file = MODULE_KEY_SOURCE_FILE[module_key]
            if source_file not in required_files:
                raise HarnessError(
                    "check "
                    + check_id
                    + " needs "
                    + source_file
                    + " but target "
                    + name
                    + " does not require it"
                )


PROOF_MODE = "proof"
DEVELOPER_MODE = "developer"


def resolve_run_mode(target_name):
    """Decide which of the two callers is running this file, and refuse
    anything in between.

    Two different callers run the same Taskfile command, and they need
    different things from it.

    The campaign worker runs ``task verify:evidence-labels`` as its own verify
    step, to find out whether the code it just wrote is right. It gets that
    answer from the exit code. It does not set the ``CCC_PROOF_*`` variables
    and cannot: its sandbox builds the child environment from scratch and
    passes only what it chose to pass.

    Fusion's proof harness runs the same command to obtain admissible
    evidence. It sets all four variables, and it needs the envelope on stdout.

    So: no variables at all means the worker is asking a yes/no question, and
    it gets one -- every check runs exactly as it does in proof mode, the
    human summary and the per-check ledger go to stderr, stdout stays empty,
    and the exit code is 0 or 1 by the same conjunction of declared ids.
    All four set means the harness is asking for evidence, and it gets the
    envelope. Anything in between is refused, because a partial identity is
    not a caller, it is a dispatch defect.

    The envelope is never emitted under a borrowed or invented identity.
    That is the whole reason developer mode writes nothing to stdout rather
    than filling in placeholder values: an envelope is a claim about a
    specific proof at a specific commit, and a run that does not know which
    proof or which commit has no such claim to make.
    """
    defined = [variable for variable in PROOF_ENV_VARS if variable in os.environ]
    if not defined:
        return DEVELOPER_MODE, None
    values = {}
    for variable in PROOF_ENV_VARS:
        value = os.environ.get(variable, "")
        if not value:
            raise HarnessError(
                "required proof environment variable is missing or empty: "
                + variable
                + "; either set all four (proof mode) or none of them "
                "(developer mode), never some"
            )
        values[variable] = value
    declared_id = PROOF_DECLARATIONS[target_name]["proofId"]
    if values["CCC_PROOF_ID"] != declared_id:
        raise HarnessError(
            "CCC_PROOF_ID "
            + repr(values["CCC_PROOF_ID"])
            + " does not match the proof id pinned for target "
            + target_name
            + " ("
            + declared_id
            + ")"
        )
    return PROOF_MODE, (
        values["CCC_PROOF_ID"],
        values["CCC_PROOF_PHASE"],
        values["CCC_PROOF_SOURCE_COMMIT"],
        values["CCC_PROOF_SOURCE_TREE"],
    )


# ---------------------------------------------------------------------------
# running the declared checks
# ---------------------------------------------------------------------------


def judge(name, fixture):
    """Locate, import and interrogate the candidate. Returns a finished Ledger.

    Raises ``ProofFailure`` when the candidate could not be set up at all, and
    ``HarnessError`` only for defects in this file. Every other exception a
    check can raise -- including ``SystemExit`` and ``RecursionError`` -- is
    recorded as that check's failure and the run continues, so one bad check
    never hides the state of the others and never empties stdout.
    """
    required_files, execute_init = TARGET_REQUIREMENTS[name]
    repo_src, package_dir = locate_candidate(required_files)
    install_source_root(repo_src)
    loaded, new_top_level = import_candidate(package_dir, required_files, execute_init)
    ctx = {
        "fixture": fixture,
        "loaded": loaded,
        "package_dir": package_dir,
        "required_files": required_files,
        "new_top_level": new_top_level,
    }
    ledger = Ledger(fixture["checks"])
    for check_id in fixture["checks"]:
        try:
            CHECKS[check_id](ctx)
        except ProofFailure as error:
            ledger.record(check_id, False, str(error))
            continue
        except HarnessError:
            # A defect in this file, not a candidate verdict. Nothing further
            # can be judged reliably, so the whole run is refused.
            raise
        except BaseException as error:  # noqa: BLE001 - every fixture key this
            # check reads was validated before any candidate code ran, so
            # anything landing here came from the candidate: a TypeError, a
            # SystemExit from sys.exit(), a RecursionError, anything.
            ledger.record(check_id, False, type(error).__name__ + ": " + str(error))
            continue
        ledger.record(check_id, True)
    ledger.finish()
    return ledger


def evaluate_declaration(declaration, ledger):
    """Turn the check ledger into one result per declared id.

    A declared id passes exactly when every check mapped to it passed. There
    is no positive/negative bucket: the mapping decides, so a clause whose
    negative evidence failed reports false.
    """
    results = {}
    failures = []
    for section, _id_key in DECLARATION_SECTIONS:
        section_results = []
        for entry_id, check_ids in declaration[section]:
            failed = [
                check_id for check_id in check_ids if not ledger.outcomes[check_id][0]
            ]
            section_results.append((entry_id, not failed))
            if failed:
                failures.append(entry_id + " <- " + ", ".join(sorted(failed)))
        results[section] = tuple(section_results)
    detail_lines = []
    for check_id in ledger.executed:
        passed, detail = ledger.outcomes[check_id]
        if not passed:
            detail_lines.append(check_id + ": " + (detail or "(no detail)"))
    summary = "; ".join(failures + detail_lines)
    return results, summary


def all_false_results(declaration):
    """Nothing was proven, so nothing is honestly true."""
    return {
        section: tuple((entry_id, False) for entry_id, _ in declaration[section])
        for section, _id_key in DECLARATION_SECTIONS
    }


# ---------------------------------------------------------------------------
# canonical JSON, byte-identical to canonicalCccPrdJson
# ---------------------------------------------------------------------------


def _canonical_json_string(text):
    """Encode ``text`` as one JSON string literal, character by character,
    matching ``JSON.stringify``'s escape table exactly: the quote/backslash
    pair, the named control-character shorthands, ``\\u00XX`` for every other
    control code point, and ``\\uXXXX`` for a lone (unpaired) UTF-16
    surrogate -- everything else, ASCII and non-ASCII alike, passes through
    raw. This does not delegate to ``json.dumps``: with ``ensure_ascii=False``
    it already agrees on every point above except lone surrogates, which it
    does not escape, so a hand-rolled encoder is what makes the byte-for-byte
    claim actually true rather than true "in the cases tried so far".
    """
    pieces = ['"']
    for char in text:
        code = ord(char)
        if char == '"':
            pieces.append('\\"')
        elif char == "\\":
            pieces.append("\\\\")
        elif char == "\b":
            pieces.append("\\b")
        elif char == "\f":
            pieces.append("\\f")
        elif char == "\n":
            pieces.append("\\n")
        elif char == "\r":
            pieces.append("\\r")
        elif char == "\t":
            pieces.append("\\t")
        elif code < 0x20 or 0xD800 <= code <= 0xDFFF:
            pieces.append("\\u%04x" % code)
        else:
            pieces.append(char)
    pieces.append('"')
    return "".join(pieces)


def _canonical_sort_key(text):
    """Sort object keys the way ``compareCccPrdCodeUnits`` does: ascending by
    UTF-16 code unit. This agrees with Python's default code-point ordering
    for every key this envelope ever has (plain ASCII field names), but the
    two orders diverge for an astral character, so the comparison is done on
    the actual UTF-16 bytes rather than trusting that agreement to hold
    forever. ``surrogatepass`` keeps this from raising on a lone surrogate,
    which is not a valid encode target but must still sort deterministically.
    """
    return text.encode("utf-16-be", "surrogatepass")


def canonical_json(value, path="$"):
    """Mirror ``canonicalCccPrdJson`` (packages/core/src/ccc-prd/contract.ts)
    byte for byte: object keys sorted by UTF-16 code unit, no inserted
    whitespace, and string/bool/int/None encoding equivalent to
    ``JSON.stringify``.

    Accepted value domain: ``str``, ``bool``, ``int``, ``None``, ``list``/
    ``tuple`` of accepted values, and ``dict`` with ``str`` keys and accepted
    values. This envelope never carries a float, and ``JSON.stringify``'s own
    number formatting (a shortest-round-trip algorithm) has no exact Python
    equivalent worth risking, so a float -- or anything else outside this
    domain -- is refused with a ``HarnessError`` rather than silently
    mis-encoded; this is a defect in this file, never a candidate verdict,
    which is why it raises the exception ``main`` treats that way.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _canonical_json_string(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        raise HarnessError(
            "CCC PRD canonical JSON does not accept floats (at " + path + "): " + repr(value)
        )
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(
            canonical_json(entry, path + "[" + str(index) + "]")
            for index, entry in enumerate(value)
        ) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise HarnessError(
                    "CCC PRD canonical JSON object keys must be str (at " + path + "): " + repr(key)
                )
        items = sorted(value.items(), key=lambda kv: _canonical_sort_key(kv[0]))
        return "{" + ",".join(
            _canonical_json_string(key) + ":" + canonical_json(entry, path + "." + key)
            for key, entry in items
        ) + "}"
    raise HarnessError(
        "CCC PRD canonical JSON values must be str/bool/int/None/list/dict (at "
        + path + "): " + type(value).__name__
    )


def build_evidence_envelope(results, identity):
    proof_id, phase, source_commit, source_tree = identity
    entries = []
    for section, id_key in DECLARATION_SECTIONS:
        entries.append([
            {id_key: entry_id, "passed": passed} for entry_id, passed in results[section]
        ])
    clause_results, positive_case_results, negative_control_results = entries
    overall = all(
        passed
        for section, _ in DECLARATION_SECTIONS
        for _entry_id, passed in results[section]
    )
    envelope = {
        "schema": CCC_PROOF_EVIDENCE_SCHEMA,
        "proofId": proof_id,
        "phase": phase,
        "sourceCommit": source_commit,
        "sourceTree": source_tree,
        "passed": overall,
        "clauseResults": clause_results,
        "positiveCaseResults": positive_case_results,
        "negativeControlResults": negative_control_results,
    }
    return envelope, overall


# ---------------------------------------------------------------------------
# stdout custody
# ---------------------------------------------------------------------------


CUSTODY_FD_CEILING = 250
CUSTODY_FD_FLOOR = 200


class StdoutCustody:
    """Hold the real stdout privately for the life of the run.

    Descriptor 1 is pointed at stderr on entry, so a candidate's ``print()``,
    a rebound ``sys.stdout``, and a raw ``os.write(1, ...)`` all land on
    stderr. The envelope is written to a private duplicate instead.

    Two duplicates are taken, not one, and both are placed at high descriptor
    numbers rather than the lowest free slot. The lowest free slot is exactly
    what the next ``open()`` in candidate code would be handed, so a candidate
    that opens a file could otherwise be given the descriptor this file is
    about to write the proof to. Taking two means a candidate that closes one
    of them still cannot empty stdout: the write falls back to the second, and
    only if both fail does the run refuse instead of emitting a partial line.
    If the descriptor dance is unavailable at all, the stream object captured
    at construction time is used, which still survives a rebound
    ``sys.stdout``.
    """

    def __init__(self):
        self.fds = []
        self.stream = sys.stdout
        try:
            sys.stdout.flush()
        except BaseException:  # noqa: BLE001 - a broken stdout is handled below
            pass
        for _ in range(2):
            duplicate = self._dup_high(1)
            if duplicate is None:
                break
            self.fds.append(duplicate)
        if not self.fds:
            return
        try:
            os.dup2(2, 1)
        except BaseException:  # noqa: BLE001 - keep the duplicates but accept
            # that descriptor 1 still points at the real stdout; the
            # redirect_stdout guard around the candidate phase remains.
            pass

    def _dup_high(self, source):
        """Duplicate ``source`` onto a free high descriptor number."""
        for target in range(CUSTODY_FD_CEILING, CUSTODY_FD_FLOOR - 1, -1):
            if target in self.fds:
                continue
            try:
                os.fstat(target)
            except OSError:
                pass  # free
            else:
                continue  # already in use by someone
            try:
                os.dup2(source, target)
            except BaseException:  # noqa: BLE001
                continue
            return target
        try:
            return os.dup(source)
        except BaseException:  # noqa: BLE001
            return None

    @staticmethod
    def _write_all(fd, data):
        """Write every byte. Returns (complete, bytes_written).

        The byte count is what makes the fallback safe: both saved handles
        refer to the same open file, so retrying after a partial write would
        emit those bytes twice and corrupt the one line Fusion parses. Only a
        handle that wrote nothing at all may be retried on another.
        """
        view = memoryview(data)
        sent = 0
        while view:
            try:
                written = os.write(fd, view)
            except BaseException:  # noqa: BLE001 - report how far we got
                return False, sent
            if written <= 0:
                return False, sent
            sent += written
            view = view[written:]
        return True, sent

    def emit(self, text):
        """Write the one envelope line. Returns True only on a complete write."""
        try:
            data = (text + "\n").encode("utf-8")
        except BaseException:  # noqa: BLE001
            return False
        for fd in self.fds:
            complete, sent = self._write_all(fd, data)
            if complete:
                return True
            if sent:
                return False  # partial write; retrying would duplicate bytes
        if self.fds:
            return False
        try:
            buffer = getattr(self.stream, "buffer", None)
            if buffer is not None:
                buffer.write(data)
                buffer.flush()
            else:
                self.stream.write(text + "\n")
                self.stream.flush()
            return True
        except BaseException:  # noqa: BLE001
            return False

    def close(self):
        for fd in self.fds:
            try:
                os.close(fd)
            except BaseException:  # noqa: BLE001
                pass
        self.fds = []


def _harden_stderr():
    """Make stderr unable to lose a line to its own encoding.

    The worker's verify command runs through ``/usr/bin/env -i``
    (``run-verification-tool.ts:633``), so the child starts with only the
    variables that path chose to pass. ``LANG``, ``LC_ALL`` and ``LC_CTYPE``
    are on its allowlist (``run-verification-tool.ts:54-56``) and are
    forwarded when the parent process has them, which a daemon-launched
    parent often does not. CPython already handles that well on its own --
    the POSIX locale turns on UTF-8 mode, and ``sys.stderr`` has defaulted to
    the ``backslashreplace`` error handler since 3.5 -- so this is not
    repairing a defect. It is refusing to depend on an interpreter default
    for something load-bearing: in developer mode this stream carries the
    entire verdict, and a check's failure detail can quote candidate text,
    which is arbitrary.
    """
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    except BaseException:  # noqa: BLE001 - _stderr carries its own fallback
        pass


def _stderr(message):
    """Write one diagnostic line, and never raise doing it.

    The blanket guard exists because a diagnostic must not be able to end the
    run. But swallowing an encoding failure would mean silently dropping the
    line, and in developer mode the dropped line could be the one naming the
    check that failed. So an encoding failure is retried against whatever the
    stream can actually represent, with the offending characters escaped
    rather than the line discarded. Everything else -- a closed stream, a
    full pipe -- stays silent, because there is nowhere left to report it.
    """
    try:
        sys.stderr.write(message + "\n")
        sys.stderr.flush()
        return
    except UnicodeEncodeError:
        pass
    except BaseException:  # noqa: BLE001 - stderr is diagnostic only
        return
    try:
        encoding = getattr(sys.stderr, "encoding", None) or "ascii"
        escaped = message.encode(encoding, "backslashreplace").decode(encoding, "replace")
        sys.stderr.write(escaped + "\n")
        sys.stderr.flush()
    except BaseException:  # noqa: BLE001
        pass


def refuse(message):
    """Harness refusal: nothing on stdout, one line on stderr, exit 2."""
    _stderr("HARNESS REFUSED: " + message)
    return 2


def report_developer_result(name, ledger, results, summary, overall_passed):
    """Developer mode's whole output: stderr only, and an exit code.

    The worker reading this needs to know which checks failed and why, so
    every check is listed with its outcome and its own failure detail, then
    every declared id, then the same PROOF PASSED / PROOF FAILED line proof
    mode writes. Nothing goes to stdout: this run has no proof identity, so
    it has no envelope to emit, and a placeholder envelope would be a claim
    about a proof and a commit this run knows nothing about.
    """
    _stderr(
        "DEVELOPER MODE: no CCC_PROOF_* variables are set, so this run reports "
        "a verdict through its exit code only and writes no proof evidence."
    )
    if ledger is not None:
        for check_id in ledger.executed:
            passed, detail = ledger.outcomes[check_id]
            line = "  " + ("ok   " if passed else "FAIL ") + check_id
            if not passed and detail:
                line += ": " + detail
            _stderr(line)
    else:
        _stderr("  (no check ran; the candidate could not be set up at all)")
    for section, id_key in DECLARATION_SECTIONS:
        for entry_id, passed in results[section]:
            _stderr("  " + ("ok   " if passed else "FAIL ") + entry_id)
    if not overall_passed:
        _stderr("PROOF FAILED: " + summary)
        return 1
    _stderr(
        "PROOF PASSED: "
        + name
        + " ("
        + str(len(ledger.executed))
        + " checks: "
        + ", ".join(ledger.executed)
        + ")"
    )
    return 0


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main(argv):
    _harden_stderr()
    custody = StdoutCustody()
    try:
        # --- harness stage: any failure here is a refusal -------------------
        try:
            target_dir = parse_args(argv)
            name, fixture = load_fixture(target_dir)
            declaration = PROOF_DECLARATIONS[name]
            mode, identity = resolve_run_mode(name)
            if mode == DEVELOPER_MODE:
                # Nothing will be written to stdout on this path, so the two
                # duplicated descriptors have no remaining purpose -- and an
                # open duplicate of the real stdout is exactly what a
                # candidate must not be able to find. Closing them here, before
                # any candidate code is imported, means a candidate that walks
                # the descriptor table and writes to everything open cannot
                # reach the real stdout at all. Descriptor 1 keeps pointing at
                # stderr, so ordinary candidate output is still diverted.
                custody.close()
        except HarnessError as error:
            return refuse(str(error))
        except BaseException as error:  # noqa: BLE001 - a bug in this file's own
            # preparation is still the harness's, never a candidate verdict.
            return refuse(
                "unexpected " + type(error).__name__ + " while preparing the proof: " + str(error)
            )

        # --- candidate stage: failures here are graded -----------------------
        ledger = None
        candidate_failure = None
        try:
            with contextlib.redirect_stdout(sys.stderr):
                ledger = judge(name, fixture)
        except ProofFailure as error:
            candidate_failure = str(error)
        except HarnessError as error:
            return refuse(str(error))
        except BaseException as error:  # noqa: BLE001 - every check body already
            # has its own guard, so anything escaping came from locating or
            # importing candidate code. Grading it keeps a candidate from
            # forcing a refusal by dying in an unusual way.
            candidate_failure = "unexpected " + type(error).__name__ + ": " + str(error)

        # --- envelope: reading the ledger and serializing it are both this
        # file's own work, so a defect in either is a refusal, not a graded
        # result. evaluate_declaration walks the mapping table and the ledger;
        # if it ever raised, exiting 1 with a half-built answer would report a
        # candidate verdict this file never actually reached.
        try:
            if candidate_failure is not None:
                results = all_false_results(declaration)
                summary = candidate_failure
            else:
                results, summary = evaluate_declaration(declaration, ledger)
            if mode == DEVELOPER_MODE:
                # No identity, so no envelope. The verdict itself is the same
                # conjunction the envelope would have carried in "passed".
                envelope_text = None
                overall_passed = all(
                    passed
                    for section, _ in DECLARATION_SECTIONS
                    for _entry_id, passed in results[section]
                )
            else:
                envelope, overall_passed = build_evidence_envelope(results, identity)
                envelope_text = canonical_json(envelope)
        except BaseException as error:  # noqa: BLE001
            return refuse(
                (
                    "could not evaluate the declared results"
                    if mode == DEVELOPER_MODE
                    else "could not build the proof-evidence envelope"
                )
                + ": "
                + type(error).__name__
                + ": "
                + str(error)
            )

        if mode == DEVELOPER_MODE:
            try:
                return report_developer_result(name, ledger, results, summary, overall_passed)
            except BaseException as error:  # noqa: BLE001 - writing the report
                # is this file's own work, so a defect in it is a refusal.
                # Letting it escape would end the run with a traceback and
                # exit 1, and exit 1 is the verdict "the candidate failed" --
                # a verdict this file never actually reached. Nothing has been
                # written to stdout on this path, so refusing here is still
                # honest and stdout is still empty.
                return refuse(
                    "could not report the developer-mode result: "
                    + type(error).__name__
                    + ": "
                    + str(error)
                )

        if not custody.emit(envelope_text):
            return refuse("could not write the proof-evidence envelope to stdout")

        # Deliberately not guarded the way the developer-mode report above is.
        # The envelope is on stdout now, and exit 2 means "nothing was written";
        # refusing here would hand Fusion an envelope and a refusal at once.
        # What remains is a formatted stderr line built from values already
        # proved well-formed, and _stderr cannot raise.

        if not overall_passed:
            _stderr("PROOF FAILED: " + summary)
            return 1
        _stderr(
            "PROOF PASSED: "
            + name
            + " ("
            + str(len(ledger.executed))
            + " checks: "
            + ", ".join(ledger.executed)
            + ")"
        )
        return 0
    finally:
        custody.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
