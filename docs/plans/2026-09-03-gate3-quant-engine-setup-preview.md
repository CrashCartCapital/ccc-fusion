---
type: reference
domain: ccc
status: draft
version: 1.0.0
date_created: 2026-09-03
date_modified: 2026-09-03
---

# Gate 3 Quant Engine Setup Preview

## What you are being asked to approve

Nothing has been written to `ccc-quant-engine`. Every file described here lives in a staging folder inside `ccc-fusion`, at `docs/plans/gate3-quant-engine-setup-draft/`. This document is the preview you are owed before anyone copies those files into your quant-engine repository and commits them. The quant-engine repository was read from and never written to; its branch, its commit, and its working tree are exactly as they were.

The commit being proposed adds six files and touches one existing file. It adds no product code, changes no engine behaviour, and removes nothing.

## Why this commit has to exist at all

CCC-Fusion is the system that will run an AI campaign against your quant engine. Before it starts, it freezes a "packet": a sealed description of what the campaign must build and how anyone will know it worked. The thing that decides whether the campaign succeeded is called the verifier, and it is a small program that runs the finished code and checks its behaviour.

The rule that forces this commit is short and non-negotiable. Fusion reads the verifier's bytes out of the Git history at the exact commit the packet was frozen against. It does not read them from the working directory, and it does not read them from wherever the campaign happened to leave files. It also refuses any verifier that sits inside a folder the campaign is allowed to write to. Put those two rules together and the conclusion is forced: **a campaign cannot write its own grader**. The grader has to be committed first, by a human, into a place the campaign can never touch.

That is the entire purpose of this commit. It is the referee walking onto the pitch before the match, not during it.

There is a second, more mundane reason. Fusion accepts only a very narrow shape of command as proof authority, and not one of the seven existing `verify:` commands in your Taskfile qualifies. Each one is disqualified several times over, for reasons like carrying a human-readable description line, chaining to other commands, or using an equals sign in an environment setting. None of that is a defect in your Taskfile; it is simply a different grammar than the one Fusion's proof reader accepts. So four new commands have to be added that do speak that grammar.

## What the commit adds, in plain terms

**One change to `Taskfile.yml`.** Four new command entries are appended at the end of the file. Each one is a single line that runs the new checker against one of four case folders. Nothing already in the file is edited, reordered, renamed, or removed. Your existing `setup`, `test`, `lint`, `format`, `docs:smoke`, `typecheck`, `verify`, `verify:deps`, `verify:m0`, `verify:m1`, `verify:m2`, `verify:validation-install`, `verify:validation-oracle`, and `lint:network-boundary` commands all keep working exactly as they do today. The merged file was parsed and counted: fourteen existing commands, four new ones, eighteen total.

**One new checker, `verify/qe_evidence_adapter.py`.** This is the referee. It is a single Python file that uses only what ships with Python itself, so it adds no dependency and requires no change to `pyproject.toml` or `uv.lock`. It loads the code the campaign wrote, calls its public functions, compares the answers against a fixed list of expected results, and exits with a success or failure code. The exit code alone used to be treated as the whole proof signal, and that was wrong: Fusion's harness does not trust a bare exit code, it re-parses the referee's own stdout as one line of canonical JSON naming the proof, the source commit and tree, and a pass/fail result for every clause, positive case, and negative control the proof declares, and it refuses anything else, human-readable prose included. The referee's stdout is the whole proof signal; the exit code is a secondary check that the JSON and the process outcome agree.

**Four small data files**, at `verify/cases/labels/cases.json`, `verify/cases/verdict/cases.json`, `verify/cases/candidate/cases.json`, and `verify/cases/integrated/cases.json`. These are the answer key. Each one lists the inputs the checker will feed in, the answers it demands back, and the deliberately wrong behaviours it must refuse. Keeping the answer key in data rather than in code means you can read what is being demanded without reading Python, and it means the campaign can read it too, which is deliberate. The rules are meant to be knowable in advance, not a trap.

## What it does not change

- **Nothing is created under `src/qe_evidence/`.** That folder does not exist today and must not exist at the baseline. It is the one place the campaign is allowed to write, and Fusion refuses the entire packet if any part of the referee lives inside it, in either direction of containment. This was checked against all six proposed file paths.
- **No existing Taskfile command is altered.** No line is edited or deleted; four blocks are appended.
- **No source file, test, tool, configuration file, or lockfile is touched.** The referee is standard-library-only precisely so nothing about your environment has to change.
- **No engine behaviour changes.** Nothing in this commit runs unless someone explicitly types one of the four new commands.

## Which branch it lands on

`agent/stage-c-baseline`. This needs saying clearly, because the obvious answer is wrong. Your `origin/main` holds only seven commits and four files, with no `src/`, no `tests/`, and no `Taskfile.yml`. All the engine code lives on `agent/stage-c-baseline`, which is fifty-one commits ahead of `origin/main` and is the only branch containing the pinned baseline commit `c29171c20d0707a419ee0355b5c53198c9baca3f`. This was confirmed directly rather than assumed.

Because Fusion reads the referee out of Git history, the act of committing changes the commit identifier. The draft PRD's `Baseline commit:` line currently names `c29171c2` and will have to be updated to the new commit's identifier after this lands. That is a one-line edit and it is mandatory.

## What could go wrong if this is wrong

The failure that matters is a **silent false green**: a referee that passes a campaign which built nothing, or built the wrong thing. If that happened, Gate 3 would report success while proving nothing, and every conclusion drawn from it would be worthless.

Six things were done to make that specific failure hard.

First, the checker stops before a single import if the code it is meant to judge is missing. It checks that the folder exists, that each expected file exists, and that each file is non-empty. A campaign that writes nothing fails the proof outright — exit code 1, every declared item marked false, and a message naming the missing path.

Second, every check the checker knows how to run has a name, and each answer-key file lists exactly which named checks that proof requires. At the end of a run the checker compares the checks it actually executed against the list it was told to execute, and refuses to report success unless the two sets are identical and non-empty. A run cannot pass by quietly skipping work.

Third, each proof declares the acceptance clauses, positive cases, and negative controls it is supposed to establish, and the checker holds a table saying which named checks establish each one. An item passes only when every check named for it passed. Before anything is judged, the checker refuses to run if any declared item names no check, names a check the answer key does not list, or if the answer key lists a check that establishes nothing declared. So the evidence for a claim cannot be quietly removed and the claim still come back green.

Fourth, the checker tests itself on every run. It builds deliberately broken shapes — a package missing one of its joined exports, a package that renamed one, a package that copied a function instead of joining it, a package that copied a value instead of joining it, code that reaches outside the standard library — hands them to the same judgement it applies to the real candidate, and stops the whole run unless every one is refused. Stops, not fails: nothing in that paragraph is the candidate's work, so a failure there means the instrument is broken, and the checker says so and produces no verdict at all rather than blaming the code it was asked to judge. It also checks the broken shapes themselves: if a stand-in it built comes back as the very object it was supposed to replace, the run stops, because a control that has quietly become faithful would fail a correct candidate rather than catch a wrong one. The answer key is checked for controls that control for nothing in the same spirit: a list of "invalid" labels that are all in fact valid, a "malformed" gate mapping that is in fact well formed, or a set of copy controls that only ever copies functions and never a value, stops the run.

Fifth, the four proofs must each establish what the requirements document says they establish. The checker holds a second, separate list of which claims, oracles and controls belong to each of the four stages, read straight off the document's own "Expected proof" paragraphs, and refuses to run if any stage declares less than that or more. It also refuses if a claim proved at more than one stage rests on less evidence at the later one, and if the join claim anywhere fails to carry the evidence the leaf stages used, since its own wording is that the join changed no leaf behaviour. The previous version of this rule compared claims by name across stages and had nothing to say about a stage that simply stopped declaring one — which is the easier way to weaken a proof and the harder one to notice.

Sixth, twenty-seven deliberately broken implementations were written and run through the checker. All twenty-seven were rejected. The table is below.

The residual risk is narrower. It is that a *correct* implementation is rejected for a reason the specification never stated, which would waste campaign turns rather than produce a false result. The largest instance of that is the one place where the draft PRD is genuinely silent, described next.

One thing the checker deliberately does not try to do, now written at the top of the file itself so it stays decided: it is built to be honest against ordinary or wrong work from a worker whose output arrives as a reviewable change, not against code actively trying to fool it. A candidate determined to evade it could hide an import from every scan, or kill the process outright, or take away the file handles the checker is holding. None of those routes ends in a false pass — every one of them ends either as a refusal, which the campaign records as a refusal, or as something a person reading the change would notice immediately. Building defences against them would add code and complexity for no gain in honesty, so none are built.

## One place where the specification was silent, and what was decided

The PRD says the verdict function must return "blocking reasons naming each unmet condition in canonical order". It never says what those reason strings should say. A referee that demanded exact wording would be demanding something nobody could guess.

The decision taken: the checker judges reasons by a contract rather than by exact text. It requires one reason for each unmet condition, requires that reason to contain that condition's name somewhere inside it, requires the whole list to be sorted, and requires the list to be empty exactly when the verdict is promotable. Any sensible phrasing satisfies this. A single lumped "not promotable" message does not, and neither does a list that quietly drops one of the reasons. This contract is written in plain English at the top of every answer-key file, so the campaign can read it.

If you disagree with that reading, this is the one design decision in the commit worth changing before it lands.

## Interpreter sealing: how close are we to the limits?

Fusion seals the entire Python runtime it will use, and refuses if that runtime exceeds sixteen root directories, two hundred thousand files, or one gibibyte. This path has never been run against your environment, so it was measured rather than assumed.

The measurement turns on one detail in Fusion's discovery code: it launches Python with the `-S` flag, which disables the mechanism that makes a virtual environment's packages visible. As a result, the sealed set is the base interpreter's own library, not your project's installed dependencies.

| Sealed set | Roots | Files | Size | Share of cap |
|---|---|---|---|---|
| Base interpreter library, `-S` (expected case) | 3 | 1,594 | 30 MB | 0.8% of files, 2.9% of bytes |
| Plus the project virtual environment, if the controller declares it | 4 | 16,151 | 651 MB | 8.1% of files, 63.6% of bytes |

The expected case has very large headroom. The second row is the case where whoever configures the run explicitly points Fusion at `/Users/ryanpappal/03_CODE/ccc-quant-engine/.venv/lib/python3.12/site-packages`, which holds 14,557 files and 621 MB on its own. It still fits, but it consumes nearly two thirds of the byte allowance and would leave little margin if dependencies grew. Since the new code is standard-library-only, there is no reason to declare that root at all, and the recommendation is not to.

Numbers were taken by walking the real directories on this machine on 2026-09-03. They are current-state measurements, not a guarantee about a future environment.

## Verification actually performed

Every item below was executed, not reasoned about. The scratch work lives at `/Users/ryanpappal/03_CODE/ccc-fusion/.archive/l6-scratch/` and ships nowhere.

| # | Check | Result |
|---|---|---|
| 1 | Merged Taskfile parses under Fusion's exact strictness: strict mode, unique keys, zero warnings | Pass, 0 errors and 0 warnings |
| 2 | No YAML anchors or aliases anywhere in the merged document | Pass |
| 3 | Root keys limited to `version` and `tasks` | Pass |
| 4 | Existing targets untouched, count correct | Pass, 14 existing plus 4 new equals 18 |
| 5 | All four new targets satisfy the four-token Python command shape | Pass |
| 6 | Each of the four targets has a fixture path beginning with its own target path plus a slash | Pass, one per target |
| 7 | No drafted closure path overlaps `src/qe_evidence` or `.fusion`, checked in both containment directions | Pass, 6 paths checked |
| 8 | Checker compiles | Pass |
| 9 | Checker imports are standard-library only | Pass, imports are `ast`, `contextlib`, `importlib`, `importlib.machinery`, `importlib.util`, `json`, `os`, `sys`, `types` |
| 10 | Checker exits nonzero when the candidate folder is absent | Pass, exit code 1 and a complete machine-readable answer |
| 11 | Checker exits nonzero when the candidate folder is present but empty | Pass, exit code 1 and a complete machine-readable answer |
| 12 | Checker exits nonzero on malformed arguments | Pass, exit code 2 and nothing on the answer stream |
| 13 | Reference implementation, written to scratch only, passes all four proofs | Pass, exit code 0 on all four |
| 14 | Checker gives the worker a usable verdict with no proof identity set | Pass, exit code 0 or 1 on all four, per-check reasons on the error stream, nothing on the answer stream |
| 15 | Checker still refuses a half-supplied proof identity | Pass, exit code 2 and nothing on the answer stream, on all four |
| 16 | A fault in the checker's own reporting refuses instead of blaming the code under test | Pass, exit code 2 and nothing on the answer stream, on all four |
| 17 | Code under test that writes to every open handle cannot reach the answer stream | Pass, answer stream empty on all four |
| 18 | Twenty-seven deliberately wrong implementations are rejected | Pass, 27 of 27 |
| 19 | `src/qe_evidence/` and `verify/` do not exist in the target repository or at the baseline commit | Pass, both absent |
| 20 | Target repository unchanged: same branch, same HEAD, no new files from this work | Pass |

The exact commands and stderr for items 10 through 12:

The first two are the candidate's absence, so they are graded failures with a complete machine-readable answer on the answer stream. The third is a defect in how the referee was invoked, so it writes nothing at all and refuses.

```
$ python3 verify/qe_evidence_adapter.py --target verify/cases/labels
PROOF FAILED: candidate package directory does not exist: .../src/qe_evidence (the campaign wrote no implementation)
exit=1, 510 bytes of machine-readable answer, every declared item false

$ python3 verify/qe_evidence_adapter.py --target verify/cases/labels    # folder exists, empty
PROOF FAILED: candidate file is missing: .../src/qe_evidence/labels.py
exit=1, 510 bytes of machine-readable answer, every declared item false

$ python3 verify/qe_evidence_adapter.py
HARNESS REFUSED: usage: python3 verify/qe_evidence_adapter.py --target verify/cases/<name>
exit=2, nothing at all on the answer stream
```

All four proofs against the correct reference implementation:

```
PROOF PASSED: labels (7 checks: vocabulary_frozen, canonical_labels_positive, canonical_labels_order_and_type, canonical_labels_rejects_invalid, merge_labels_positive, merge_labels_preserves_inputs, stdlib_only_imports)
PROOF PASSED: verdict (7 checks: vocabulary_frozen, promotion_gates_frozen, derive_promotion_verdicts, derive_promotion_rejects_bad_gates, verdict_value_immutable, verdict_imports_labels, stdlib_only_imports)
PROOF PASSED: candidate (15 checks: package_exports_joined, package_join_control, vocabulary_frozen, promotion_gates_frozen, canonical_labels_positive, canonical_labels_order_and_type, canonical_labels_rejects_invalid, merge_labels_positive, merge_labels_preserves_inputs, derive_promotion_verdicts, derive_promotion_rejects_bad_gates, verdict_value_immutable, verdict_imports_labels, stdlib_only_imports, stdlib_import_control)
PROOF PASSED: integrated (16 checks: vocabulary_frozen, promotion_gates_frozen, canonical_labels_positive, canonical_labels_order_and_type, canonical_labels_rejects_invalid, merge_labels_positive, merge_labels_preserves_inputs, derive_promotion_verdicts, derive_promotion_rejects_bad_gates, verdict_value_immutable, package_exports_joined, package_join_control, verdict_imports_labels, stdlib_only_imports, stdlib_import_control, deterministic_repeat)
```

## Negative controls

Each row is a separately broken implementation, run through the named proof. "Rejected" means a nonzero exit. Exit code 1 means the implementation was judged wrong; exit code 2 means the checker refused to run a proof at all.

| # | Broken behaviour | Proof target | Rejected | Exit |
|---|---|---|---|---|
| 1 | Drops an input label | `verify:evidence-labels` | yes | 1 |
| 2 | Admits an unadmitted label | `verify:evidence-labels` | yes | 1 |
| 3 | Accepts a malformed label by skipping it instead of raising | `verify:evidence-labels` | yes | 1 |
| 4 | Returns a non-canonical order | `verify:evidence-labels` | yes | 1 |
| 5 | Returns a mutable list instead of a tuple | `verify:evidence-labels` | yes | 1 |
| 6 | Merge drops the existing label set | `verify:evidence-labels` | yes | 1 |
| 7 | Mutated label vocabulary | `verify:evidence-labels` | yes | 1 |
| 8 | Mutated disqualifying set | `verify:evidence-labels` | yes | 1 |
| 9 | Promotes without point-in-time evidence | `verify:evidence-verdict` | yes | 1 |
| 10 | Promotes while a disqualifying label is present | `verify:evidence-verdict` | yes | 1 |
| 11 | Promotes with an unmet gate | `verify:evidence-verdict` | yes | 1 |
| 12 | Accepts a misnamed or malformed gate mapping | `verify:evidence-verdict` | yes | 1 |
| 13 | Omits a blocking reason for an unmet condition | `verify:evidence-verdict` | yes | 1 |
| 14 | Lumps every unmet condition into one reason | `verify:evidence-verdict` | yes | 1 |
| 15 | Returns a mutable verdict value | `verify:evidence-verdict` | yes | 1 |
| 16 | Mutated promotion gate set | `verify:evidence-verdict` | yes | 1 |
| 17 | Verdict restates the vocabulary, with drift | `verify:evidence-verdict` | yes | 1 |
| 18 | Verdict restates a behaviourally identical vocabulary, caught only by source inspection | `verify:evidence-verdict` | yes | 1 |
| 19 | Imports a non-standard-library third-party module | `verify:evidence-labels` | yes | 1 |
| 20 | Imports a first-party `qe_` package | `verify:evidence-labels` | yes | 1 |
| 21 | Partial join: the package omits an export | `verify:evidence-candidate` | yes | 1 |
| 22 | Renamed export in the join | `verify:evidence-candidate` | yes | 1 |
| 23 | Join restates behaviour instead of re-exporting | `verify:evidence-candidate` | yes | 1 |
| 24 | Behaviour drift hidden behind the join | `verify:evidence-candidate` | yes | 1 |
| 25 | Nondeterministic result | `verify:evidence-integrated` | yes | 1 |
| 26 | Empty implementation files | `verify:evidence-labels` | yes | 1 |
| 27 | Implementation that raises on import | `verify:evidence-labels` | yes | 1 |

Twenty-seven controls, zero not rejected. One earlier control, an attempt to make the label validator accept non-strings by coercing them with `str()`, was found not to be a real hole: the coerced value still failed the vocabulary check, so the implementation remained correct. It was replaced with control 3, a genuine hole where invalid entries are silently skipped rather than refused.

Rows 20, 26, and 27 changed exit code in the third pass and were re-run to confirm it. They used to exit 2, the code meaning "the referee could not run a proof", because the referee treated an implementation it could not import as its own problem. Whether the code under test imports is the candidate's problem, and calling it the referee's would have let any candidate turn its own failure into a refusal — so all three are now graded failures with a complete machine-readable answer and exit code 1. The other twenty-four rows were rejected for reasons that pass did not touch and were not re-run. The fourth pass re-ran none of the twenty-seven either. The one change in it that could reach them is that a candidate asking to be interrupted is now graded rather than allowed to kill the run, and that behaviour is covered directly by four new scenarios in the evidence run below, one per proof.

The third pass also added a control the table above cannot express, because it does not test an implementation at all: the referee now feeds its own join and import judgements deliberately broken shapes and fails unless every one is refused. That is what makes the rest of this table load-bearing rather than decorative — a control that cannot fail proves nothing about the candidate. The full current evidence is at `.archive/l21-referee/84-installed-reproof-v7.json`: one hundred and forty-four scenarios run end to end through Fusion's own parser, each one stating in advance the expected value of every clause, positive case and negative control its proof declares. Asserting only that a broken candidate failed says nothing about whether the right claim failed, so every scenario also asserts that nothing else flipped. What the fifth pass changed is where those expectations come from. They used to be written by reading the checker's own evidence table and restating it, which made the two agree by construction — that can catch a checker behaving unlike its table and can never catch a table that is wrong. They are now written from the requirements document instead, under five stated reading rules, without looking at the table at all. Twenty of them are the sixth pass's: per proof, a worker-mode pass, a worker-mode failure, a worker-mode candidate that will not import, a blank variable, and a half-supplied environment. Twelve more are the seventh pass's: per proof, a failure reason that is not plain ASCII in a run given no language settings at all, an implementation that writes to every open handle it can find, and a deliberately broken reporter. All one hundred and forty-four pass.

The seventh pass also changed how every scenario is run. They used to run in an ordinary shell with the four identity variables removed, which is not what the worker does. The worker's command is wrapped in a tool that discards the entire environment and hands the command back exactly the list of variables Fusion chose to pass, so the matrix now rebuilds that list from the engine source and runs through the same wrapper. A row can no longer pass on a variable the real caller would never supply, and the language settings, which decide how the error stream encodes an unusual character, are now present or absent exactly as they would really be. What this does not reproduce is the sandbox that confines what the command can read and reach; that governs the filesystem and the network, not the environment, and none of these rows are about it.

The build that shipped before the seventh pass fails eight of the twelve new rows: on all four proofs it lets the code under test put bytes on the answer stream, and on all four it ends a broken reporter with a stack trace and the wrong exit code. It passes the other four, the ones about an unusual character, which is the honest result and the reason that change is described above as stating a guarantee rather than repairing a fault. That run is at `.archive/l21-referee/76-discrimination-report-v7.json`. The build before it, measured on the matrix as it stood then, failed exactly the twelve worker-mode rows of one hundred and thirty-two, which was the campaign halt reproduced; that run is at `.archive/l21-referee/63-discrimination-report-v6.json`. The one before that failed thirty-four of one hundred and twelve, at `.archive/l21-referee/50-discrimination-report-v5.json`.

## Fixture coverage per proof

| Proof | Named checks | Positive cases | Negative controls in data |
|---|---|---|---|
| `verify:evidence-labels` | 7 | 6 canonical cases, 7 merge cases | 7 invalid-label cases |
| `verify:evidence-verdict` | 7 | 11 verdict cases, 2 of them promotable | 4 invalid gate mappings |
| `verify:evidence-candidate` | 15 | 3 canonical, 2 merge, 4 verdict | 7 invalid-label cases, 4 invalid gate mappings, export identity on all 6 exports, 4 join controls, 3 import controls |
| `verify:evidence-integrated` | 16 | full case set from all three | full negative set, plus determinism, plus the same 4 join and 3 import controls |

The join controls are `partial_join_missing_export`, `renamed_export`, `restated_rather_than_joined`, and `restated_tuple_export`. The last two are both copy controls, and they are both needed: copying a function and copying a value fail along different paths in Python, and a control set that only ever copied functions would leave the value path untested. The import controls are `runtime_pulled_in_third_party`, `source_imports_third_party`, and `source_imports_first_party_package`. These seven are calibration rather than candidate input: the referee builds each broken shape itself and fails unless its own judgement refuses every one.

Verdict case names, which show what each one is for:

`clean_point_in_time_with_every_gate_promotes`, `paper_observation_does_not_block_promotion`, `no_point_in_time_evidence_blocks`, `disqualifying_label_blocks`, `every_disqualifying_label_is_named`, `single_unmet_gate_blocks`, `several_unmet_gates_each_named`, `no_gate_met`, `empty_labels_block`, `disqualifying_label_and_unmet_gate_both_named`, `promotable_input_label_is_not_a_shortcut`.

Invalid label cases: `unknown_label`, `lowercase_label_is_unknown`, `empty_string_label`, `whitespace_label`, `non_string_label_int`, `non_string_label_null`, `one_valid_one_invalid`.

Invalid gate mappings: `missing_gate`, `extra_gate`, `misnamed_gate`, `empty_gate_mapping`.

## Two design notes worth knowing

**Why the checker finds the code by itself.** Under Fusion's Python profile the command is exactly four tokens, `python3`, the checker, the literal word `--target`, and a folder. There is no room for the paths of the files being judged, and there is no room for an environment setting either, because the equals sign is outside the allowed character set for command tokens. So the checker adds `src` to Python's import path in its own code and imports the package from a location it hardcodes. This is safe because the checker itself is frozen in Git history and the campaign cannot edit it.

**Why the leaf proofs do not run the package's `__init__.py`.** The first two tasks write `labels.py` and `verdict.py`. The joining task writes `__init__.py`. If the leaf proofs imported the package normally, a half-written `__init__.py` could make a perfectly correct `labels.py` look broken. So the leaf proofs load the two modules under a lightweight package stand-in that skips `__init__.py` entirely, while the joining and final proofs deliberately execute it, because executing it is precisely what they are proving.

## Drafted file contents

The full drafted files are at `/Users/ryanpappal/03_CODE/ccc-fusion/docs/plans/gate3-quant-engine-setup-draft/`. The Taskfile addition, the checker, and one representative answer key are reproduced below. The remaining three answer keys are large, mechanical, and generated from the same shape; their complete contents are on disk and their case inventories are listed above.

### Taskfile.yml addition

Appended to the end of the existing `Taskfile.yml`, after the final line of the `verify:m2` block, at the same two-space indentation as every other task. Nothing above it is edited.

```yaml
# CCC-Fusion semantic-proof targets. Exactly one literal command each, no desc, no deps.
  verify:evidence-labels:
    cmds:
      - python3 verify/qe_evidence_adapter.py --target verify/cases/labels

  verify:evidence-verdict:
    cmds:
      - python3 verify/qe_evidence_adapter.py --target verify/cases/verdict

  verify:evidence-candidate:
    cmds:
      - python3 verify/qe_evidence_adapter.py --target verify/cases/candidate

  verify:evidence-integrated:
    cmds:
      - python3 verify/qe_evidence_adapter.py --target verify/cases/integrated
```

The comment line is optional. It was included in the merged file that was parse-tested, and it produced zero errors and zero warnings, so it is safe to keep or drop.

### verify/qe_evidence_adapter.py

Full text is at `docs/plans/gate3-quant-engine-setup-draft/verify/qe_evidence_adapter.py`, 126,989 bytes (sha256 `16d1a4bec1c8b9ff1c2c66afb342ea931ee0ffe5adf11d0c5e8d7063c76c7679`). It has now been through seven passes. It started at 27,073 bytes and only printed a human sentence such as "PROOF PASSED: labels (7 checks: ...)"; Fusion never trusted the exit code alone and rejected every one of those sentences, so it was rewritten to also print a machine-readable answer, reaching 34,365 bytes. A first independent review found six sharp edges — an unexpected bug in the code being judged could crash the referee before it wrote anything, a candidate that prints its own debug output could scramble the machine-readable answer, and one of the four proofs had no working example of a wrong answer — and closing those took it to 43,922 bytes. A second review found eight more, four of them serious enough that the file could have certified work it had not actually checked, and closing those took it to 86,832 bytes. A third review found ten more. One of them ran the other way and was the most serious of all: a control meant to stand in for a copied value handed back the original value unchanged, so the control concluded the checker was blind and failed a *correct* candidate. The rest closed real gaps — a candidate could end the run in a way that emptied the output entirely, the candidate proof was not re-checking five behaviours the leaf proofs had already established, and an import parked in a helper file nobody declared was never read. Closing those took it to 100,643 bytes. A fourth review found eight more, and the most serious was a misclassification: when the referee caught its own judgement accepting something it should have refused, it wrote that down as a candidate failure and shipped it as a verdict. A broken instrument was being reported as wrong work. That now refuses the run instead. The same review asked for the hardest thing in the whole exercise, described further down in this section: the evidence table had to be re-derived from the requirements document rather than restated from itself. Closing all of that took it to 117,016 bytes. The sixth pass is different in kind: it was not a review finding but a live campaign halt, described next, and it is the only pass that changed what the file does rather than how well it does it. It took the file to 122,415 bytes, and the seventh pass reviewed that change on its own and closed four findings in it. None of the seven passes has ever loosened what the checks require of the code under test.

### Two callers run this command, and they need different things

The eighth campaign run stopped before a single proof was attempted. The worker whose job is to write the code also runs `task verify:evidence-labels` itself, as its own check that what it just wrote is right. It gets that answer from the exit code. But the four `CCC_PROOF_*` variables that carry the proof's identity are set only by Fusion's proof harness, and the worker's sandbox builds its command's environment from scratch, so those variables were simply not there. The referee did the correct thing for a proof and the wrong thing for a worker: it refused, exit code 2, every time. The worker could not get a green verify no matter what it wrote, the repair loop spun, and sixty-three requests went on a gate that could not be passed.

The file now recognises both callers by exactly that signal. All four variables set means the proof harness is asking for evidence, and it gets the machine-readable answer on the answer stream, exactly as before. None of the four set means the worker is asking a yes-or-no question, and it gets one: every check runs identically, the human summary and a line per check go to the error stream, the answer stream stays empty, and the exit code is the same pass-or-fail it would have been. Some set and some not, or any of them blank, is still refused, because a half-supplied identity is not a caller — it is a dispatch fault.

What the second mode deliberately does not do is invent the missing identity so it can print something. The machine-readable answer is a claim about a named proof at a named commit; a run that knows neither has no such claim to make, and a plausible-looking answer with borrowed identity is the exact failure this whole file exists to prevent. So it writes nothing there at all.

The seventh pass reviewed that second mode on its own and found two real holes in it, both now closed. The first: if the code that writes the worker's summary had itself broken, the run would have ended with a stack trace and exit code 1, and exit code 1 is the sentence "the code under test is wrong" -- a verdict the checker never actually reached. A fault in the checker's own reporting now refuses, exit code 2 with nothing on the answer stream, the same as every other fault in the file. There is one deliberate exception, stated in the file: once the machine-readable answer has already been written, exit code 2 can no longer promise an empty answer stream, so the last few lines of the other mode stay unguarded on purpose.

The second: the checker holds two private duplicates of the real answer stream so that nothing the code under test does can empty it. In worker mode there is no answer to write, and those duplicates were still open while the code under test was being imported -- so code that walked its list of open handles and wrote to all of them could put its own bytes on the real answer stream. They are now closed the moment the checker knows it is in worker mode, before any code under test is loaded. Handle number one still points at the error stream, so ordinary output from the code under test is still diverted there.

Two smaller corrections came with them. The refusal raised when reading the check ledger fails now names what actually failed in each mode, instead of naming an answer that worker mode never builds. And the error stream is explicitly set to UTF-8 at startup, with escaping rather than discarding for anything it cannot represent, because in worker mode that stream carries the entire verdict and a check's failure reason can quote text from the code under test, which can be anything. The interpreter already behaved correctly here; the change states the guarantee in the file instead of inheriting it, and that is recorded honestly in the evidence rather than dressed up as a repair.

The two problems worth understanding from the second review, because they are the reason this file is now twice the size:

**A proof could be reported as passing on evidence that failed.** The old file sorted its checks into two buckets by name — "checks that prove good behaviour" and "checks that prove bad input is refused" — and then reported every acceptance clause using only the first bucket. So a clause that the PRD says is proved partly by refusing bad input could be reported as proved while exactly that refusal was failing. Worse, the "refuses bad input" bucket was a hardcoded list of two check names, and several of the behaviours the PRD names as controls were not on it, so for one of the four proofs the control had nothing to control and passed no matter what the code did.

**Code being judged could choose its own verdict.** The old file caught the ordinary kind of error but not the kind a program raises when it simply asks to be killed. A candidate that called `sys.exit()` would end the run with nothing written, which Fusion reads as "the referee could not run" — a refusal, not a failure. The same file also treated its own broken fixture as the candidate's fault, and treated a candidate's unparseable source as its own fault, which is the mistake in both directions at once.

What replaces the buckets: an explicit table, one entry per declared acceptance clause, positive case, and negative control of each of the four proofs, naming the exact checks that prove it and quoting the PRD sentence the mapping comes from. A declared item passes only when every check named for it ran and passed. The whole proof passes only when every declared item does. Before any code is judged, the file refuses to run at all if any declared item names no check, names a check the fixture does not declare, or if the fixture declares a check that proves nothing declared — so nobody can quietly delete the check that a control depends on and still get a green proof.

The evidence table was re-derived from the requirements document in the fifth pass, and re-deriving it found seven places where it disagreed with what the document actually says, plus one worse thing. Every citation in the table — the line numbers that were supposed to let a reader check the mapping against the document by hand — pointed at the wrong line. They landed on blank lines, section headings, and non-goals; one of them pointed at a rule about market data. The offsets were not consistent, so this was not one stale shift, it was that nobody had ever followed them. All twenty-seven are corrected and the correction is verified against the words each comment claims to be quoting. The seven mapping disagreements, what each one was, and how each was resolved, are recorded at `.archive/l21-referee/48-mapping-disagreements-v5.log`; all seven were resolved by changing the checker, never the reading.

Two of the sixteen checks now test the referee rather than the candidate. `package_join_control` and `stdlib_import_control` build deliberately broken shapes described in the fixture — a package missing one of the six joined exports, a package that renamed one, a package that copied a function instead of joining it, a package that copied a value instead of joining it, a run that pulled in a third-party module, a source file importing something outside the standard library — and hand them to the very same judgement code the real checks use. If the judgement code accepts any of them, the run stops with no verdict, because that is a fault in the referee and not in the code it was judging. Each stand-in is also checked for being a genuine stand-in before it is used: `tuple(x)` returns `x` itself in this interpreter, so the obvious way to write "a copy of this value" produces no copy at all, and a control built that way would be faithful rather than broken. Without this, "the negative control passed" only ever meant "the candidate did not happen to trip it".

Its structure, in order: a module docstring stating the single admitted invocation, the three exit codes, the two-way classification rule, and the stdout contract; the frozen constants naming the package, the source root, and which candidate files each of the four proofs requires; two exception types that separate "the implementation is wrong" from "I could not run a real proof"; a check ledger that runs every declared check to completion and records each one's own pass or fail rather than stopping at the first failure, so one broken behaviour never hides the state of every other, unrelated one; assertion helpers that enforce tuple type, ascending order, and uniqueness; the candidate locator that proves the code exists on disk before any import; the import path installer that does in code what an environment variable cannot express in the command; sixteen named checks, each run inside its own safety net so that even a completely unanticipated bug in the code being judged is caught, written down as that check's failure, and the run moves on; the two tables saying which fixture data and which candidate modules each check needs; the evidence-mapping table described above, together with the stage-order rule that refuses a clause proved on less evidence at a later stage than at an earlier one; the argument parser; a fixture loader that validates every piece of data any declared check will read, including re-deriving the expected promotion verdicts from the requirement's own rule so a fixture can never declare an expectation the requirement does not imply; a small hand-written function that reproduces Fusion's own rule for turning a result into JSON text character by character; the stdout custody described below; and `main`.

`main` runs in three stages, and which stage a failure lands in decides what Fusion is told. What follows describes proof mode; worker mode differs only in the third stage, which writes nothing to the answer stream and reports through the exit code instead. The first stage reads the arguments, the fixture, and the four dispatch environment variables. Anything wrong here is the harness's own problem, so nothing at all is written to the answer stream, one "HARNESS REFUSED" line goes to the error stream, and the process exits 2 — Fusion sees empty output and records a refusal. The second stage locates, imports, and interrogates the code under test. Anything that goes wrong here is the candidate's, including the case where the candidate asks to be killed, asks to be interrupted, or will not even parse, and it produces a complete machine-readable answer with the failing items marked false and an exit code of 1 — a graded failure, which is a different thing from a refusal and is recorded differently. Building that answer from the results is inside the same protection: if the referee's own mapping code has a bug, the run refuses with exit code 2 rather than dying with a traceback and an exit code that means "the candidate failed". The same rule now covers the two self-tests. A self-test that catches the referee's own judgement going blind used to be written down as a candidate failure and shipped in a complete answer, which reported broken work when the truth was a broken instrument; it refuses now. The third stage writes that one line. Before any of this, `main` takes the answer stream away from the candidate entirely: it keeps two private handles on the real output, at high channel numbers a candidate opening files of its own will not be handed, and points the process's own output channel at the error stream, so a candidate's `print`, a candidate that swaps out the output object, and a candidate writing straight to the raw output channel all land harmlessly on the error stream. If the first private handle is lost, the second is used. The answer is written to the private handle as one complete piece, and if that write cannot be completed the run falls back to writing nothing and exiting 2 rather than emitting half a line. The friendly "PROOF PASSED", "PROOF FAILED" and "HARNESS REFUSED" sentences are for a person watching the run; Fusion reads only the machine-readable line.

The sixteen checks are `vocabulary_frozen`, `promotion_gates_frozen`, `canonical_labels_positive`, `canonical_labels_order_and_type`, `canonical_labels_rejects_invalid`, `merge_labels_positive`, `merge_labels_preserves_inputs`, `derive_promotion_verdicts`, `derive_promotion_rejects_bad_gates`, `verdict_value_immutable`, `package_exports_joined`, `package_join_control`, `verdict_imports_labels`, `stdlib_only_imports`, `stdlib_import_control`, and `deterministic_repeat`. The `labels` proof declares seven of them, `verdict` seven, `candidate` fifteen, and `integrated` all sixteen. Three of the sixteen were sharpened in the fifth pass. The two frozen-value checks now look at the type of the object the package hands out before comparing its contents; they used to copy it into a tuple first, so a package handing out a mutable list passed a check whose whole point was that the value is frozen. The standard-library rule now also refuses the dynamic import machinery — `__import__`, `importlib`, and writing to the module table — in candidate source, since an honest module imports what it needs at the top where a reviewer can see it. And the check that verdict code takes its vocabulary from the labels module rather than restating it now recognises all three ways Python spells an assignment, not just the plainest one.

The candidate proof grew from ten to fifteen in the fourth pass: its single acceptance clause says the join must not change the label or verdict behaviour the leaf tasks proved, and half of that sentence was going unchecked, so a join could have been certified while the frozen vocabulary, the canonical order, the union completeness, the gate set, or the verdict's immutability had quietly drifted.

### verify/cases/labels/cases.json

```json
{
  "schema": "qe-evidence-cases.v1",
  "target": "labels",
  "note": "Oracle for task verify:evidence-labels. Proves the frozen vocabulary, canonical_labels, and merge_labels, including the negative controls that a dropped label, an unadmitted label, a malformed label, or a non-canonical order must be refused.",
  "blocking_reason_contract": "blocking_reasons carries exactly one entry per unmet condition, each entry containing that condition's name as a substring, the whole tuple sorted ascending, and empty exactly when promotable is true. expected_reason_tokens lists the condition names for each case.",
  "checks": [
    "vocabulary_frozen",
    "canonical_labels_positive",
    "canonical_labels_order_and_type",
    "canonical_labels_rejects_invalid",
    "merge_labels_positive",
    "merge_labels_preserves_inputs",
    "stdlib_only_imports"
  ],
  "vocabulary": [
    "CURRENT_CONSTITUENT_SURVIVORSHIP",
    "FORWARD_OPTION_OBSERVATION",
    "PAPER_OBSERVATION",
    "POINT_IN_TIME_PROVIDER",
    "PROMOTABLE",
    "PUBLIC_DATASET_REAL_PRICE_EXPLORATORY",
    "SNAPSHOT_REVISED_FUNDAMENTAL",
    "SYNTHETIC_FIXTURE",
    "YAHOO_REAL_PRICE_EXPLORATORY"
  ],
  "disqualifying": [
    "CURRENT_CONSTITUENT_SURVIVORSHIP",
    "FORWARD_OPTION_OBSERVATION",
    "PUBLIC_DATASET_REAL_PRICE_EXPLORATORY",
    "SNAPSHOT_REVISED_FUNDAMENTAL",
    "SYNTHETIC_FIXTURE",
    "YAHOO_REAL_PRICE_EXPLORATORY"
  ],
  "gates": [
    "complete_trial_accounting",
    "honest_universe",
    "human_review",
    "independent_calculation",
    "point_in_time_data",
    "realistic_costs",
    "sealed_holdout_use"
  ],
  "canonical_labels_cases": [
    { "name": "single_admitted_label", "input": ["POINT_IN_TIME_PROVIDER"], "expected": ["POINT_IN_TIME_PROVIDER"] },
    { "name": "unsorted_input_is_sorted", "input": ["SYNTHETIC_FIXTURE", "CURRENT_CONSTITUENT_SURVIVORSHIP", "PAPER_OBSERVATION"], "expected": ["CURRENT_CONSTITUENT_SURVIVORSHIP", "PAPER_OBSERVATION", "SYNTHETIC_FIXTURE"] },
    { "name": "duplicates_collapse_once", "input": ["POINT_IN_TIME_PROVIDER", "POINT_IN_TIME_PROVIDER", "PAPER_OBSERVATION"], "expected": ["PAPER_OBSERVATION", "POINT_IN_TIME_PROVIDER"] },
    { "name": "full_vocabulary_round_trip", "input": ["YAHOO_REAL_PRICE_EXPLORATORY", "SYNTHETIC_FIXTURE", "SNAPSHOT_REVISED_FUNDAMENTAL", "PUBLIC_DATASET_REAL_PRICE_EXPLORATORY", "PROMOTABLE", "POINT_IN_TIME_PROVIDER", "PAPER_OBSERVATION", "FORWARD_OPTION_OBSERVATION", "CURRENT_CONSTITUENT_SURVIVORSHIP"], "expected": ["CURRENT_CONSTITUENT_SURVIVORSHIP", "FORWARD_OPTION_OBSERVATION", "PAPER_OBSERVATION", "POINT_IN_TIME_PROVIDER", "PROMOTABLE", "PUBLIC_DATASET_REAL_PRICE_EXPLORATORY", "SNAPSHOT_REVISED_FUNDAMENTAL", "SYNTHETIC_FIXTURE", "YAHOO_REAL_PRICE_EXPLORATORY"] },
    { "name": "empty_input_is_empty", "input": [], "expected": [] },
    { "name": "disqualifying_labels_are_kept", "input": ["YAHOO_REAL_PRICE_EXPLORATORY", "SNAPSHOT_REVISED_FUNDAMENTAL", "POINT_IN_TIME_PROVIDER"], "expected": ["POINT_IN_TIME_PROVIDER", "SNAPSHOT_REVISED_FUNDAMENTAL", "YAHOO_REAL_PRICE_EXPLORATORY"] }
  ],
  "canonical_labels_invalid": [
    { "name": "unknown_label", "input": ["NOT_AN_EVIDENCE_CLASS"] },
    { "name": "lowercase_label_is_unknown", "input": ["point_in_time_provider"] },
    { "name": "empty_string_label", "input": [""] },
    { "name": "whitespace_label", "input": ["   "] },
    { "name": "non_string_label_int", "input": [7] },
    { "name": "non_string_label_null", "input": [null] },
    { "name": "one_valid_one_invalid", "input": ["POINT_IN_TIME_PROVIDER", "NOT_AN_EVIDENCE_CLASS"] }
  ],
  "merge_labels_cases": [
    { "name": "empty_into_empty", "existing": [], "incoming": [], "expected": [] },
    { "name": "incoming_empty_keeps_existing", "existing": ["SYNTHETIC_FIXTURE", "POINT_IN_TIME_PROVIDER"], "incoming": [], "expected": ["POINT_IN_TIME_PROVIDER", "SYNTHETIC_FIXTURE"] },
    { "name": "existing_empty_keeps_incoming", "existing": [], "incoming": ["PAPER_OBSERVATION"], "expected": ["PAPER_OBSERVATION"] },
    { "name": "union_of_disjoint_sets", "existing": ["SYNTHETIC_FIXTURE"], "incoming": ["PAPER_OBSERVATION"], "expected": ["PAPER_OBSERVATION", "SYNTHETIC_FIXTURE"] },
    { "name": "overlap_collapses_once", "existing": ["POINT_IN_TIME_PROVIDER", "PAPER_OBSERVATION"], "incoming": ["PAPER_OBSERVATION"], "expected": ["PAPER_OBSERVATION", "POINT_IN_TIME_PROVIDER"] },
    { "name": "disqualifying_label_survives_a_clean_incoming_set", "existing": ["CURRENT_CONSTITUENT_SURVIVORSHIP"], "incoming": ["POINT_IN_TIME_PROVIDER", "PAPER_OBSERVATION"], "expected": ["CURRENT_CONSTITUENT_SURVIVORSHIP", "PAPER_OBSERVATION", "POINT_IN_TIME_PROVIDER"] }
  ]
}
```

The version on disk is formatted with one value per line and carries a seventh merge case, `unsorted_inputs_return_canonical`. The version above is compacted for readability only; the file on disk is the authority.

## Remaining risks

**Biggest.** The four proof targets have been checked against a faithful re-implementation of Fusion's Taskfile rules, but no real `fn prd freeze` has been run. Verifier hydration, interpreter sealing, and execution-plan generation are still unexercised end to end, so a refusal from a rule not reproduced here remains possible.

**Second.** The blocking-reason contract is an inference from a silent specification, described above. If the reading is wrong, correct implementations will be rejected.

**Third.** Committing changes the baseline commit identifier, so the draft PRD's `Baseline commit:` line must be updated in the same change. Forgetting that produces a refusal whose message will point at the closure, not at the stale line.

**Fourth.** Fusion's Python discovery runs with `-S`, which is what keeps the sealed runtime small. If a future version of Fusion drops that flag, or if whoever configures the run declares the project virtual environment as an import root, the sealed set jumps from 30 MB to about 651 MB, which is 64% of the one-gibibyte cap.

## Next step if approved

Copy the six drafted files into `ccc-quant-engine` on `agent/stage-c-baseline`, append the four Taskfile blocks, stage those exact paths by name, commit, and do not push. Then update the draft PRD's baseline commit line to the new identifier. Confirm before the packet is frozen that `src/qe_evidence/` still does not exist at that commit.
