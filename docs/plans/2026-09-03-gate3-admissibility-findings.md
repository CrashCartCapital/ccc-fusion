---
type: reference
domain: ccc
status: active
version: 1.0.0
date_created: 2026-09-03
date_modified: 2026-09-03
---

# Gate 3 PRD Admissibility Findings

Companion to the draft PRD at `docs/plans/2026-09-03-gate3-quant-engine-prd-draft.md`. This records what CCC-Fusion intake actually enforces, where the written contract disagrees with the enforcing code, what a conforming proof target must look like, and how hard the translation really was.

All code references are `file:line` against the ccc-fusion working tree at the time of writing. All target-repository facts are read from `ccc-quant-engine` at the pinned baseline `c29171c20d0707a419ee0355b5c53198c9baca3f` via `git show` and `git ls-tree`; that repository was never modified and was never entered.

## Repository topology correction

The task brief stated that `agent/stage-c-baseline` is 51 commits *behind* `origin/main`. The opposite is true, and the difference matters because it decides whether a baseline can be pinned at all.

```
git rev-list --left-right --count origin/main...agent/stage-c-baseline  ->  0   51
git rev-list --left-right --count origin/main...main                    ->  0   22
git rev-list --left-right --count main...agent/stage-c-baseline         ->  1   30
```

`origin/main` is a strict ancestor of everything. It holds 7 commits and exactly four entries: `.claude`, `AGENTS.md`, `CLAUDE.md`, `README.md`. There is no `src/`, no `tests/`, and no `Taskfile.yml`. Every line of engine code lives on branches that were never pushed.

Consequence: a PRD cannot pin a baseline on `origin/main`. Verifier-closure hydration requires `Taskfile.yml` to exist as a Git blob at the pinned commit (`packages/core/src/ccc-prd/semantic-proof-custody.ts:1301`, `:1311`), and it does not exist there.

## Section 1 — Command-shape analysis, Node versus Python

### The two admissible shapes

Only two command forms pass `verifyStrictTaskTarget` (`packages/core/src/ccc-prd/semantic-proof-custody.ts:266-292`). Both are checked after a shared character ban that rejects any command containing `; & | ` $ < > \n \r \t ' " \ * ? { } ( ) [ ] ! ~` (`:212-217`, `:232-237`).

**Node shape** (`parseLiteralCommand`, `:211-229`) — the default when no `verifierProfile` is declared:

```
node <harness> <candidate> [<candidate>…]
```

Three tokens minimum. `tokens[0]` must be exactly `node`. `tokens[1]` must equal the single declared `harness` closure entry (`:345-347`). Every remaining token is a candidate path, and the full candidate list must hash-match `proof.candidateInputs` exactly — same paths, same order, verified through `computeCccPrdCandidateInputsSha256` (`:348-355`). So under the Node shape the model's implementation files appear verbatim on the command line, and the harness receives them as `argv`.

**Python shape** (`parsePythonLiteralCommand`, `:231-249`) — opt-in only, via `verifierProfile: { schema: "ccc-prd.verifier.python-adapter.v1", adapterPath, targetPath }`:

```
python3 <adapter> --target <target>
```

Exactly four tokens, no more and no fewer. `tokens[0]` must be exactly `python3` — not `python`, not `python3.12`, not an absolute path. `tokens[2]` must be the literal string `--target`. Then `tokens[1]` must equal `verifierProfile.adapterPath`, `tokens[3]` must equal `verifierProfile.targetPath`, exactly one `harness` closure entry must exist and must be the adapter, and at least one `fixture` closure entry must have a path beginning `<targetPath>/` (`:334-341`).

Every token in either shape must match `TARGET_COMMAND_TOKEN = /^[A-Za-z0-9._/-]+$/u` (`:30`). Note what is absent from that character class: `=` and `:`. That single omission disqualifies `PYTHONPATH=src`, `--ignore=tests/live`, and `-p no:cacheprovider` — three constructs that appear throughout the ccc-quant-engine Taskfile.

### Why Python is the only viable shape for this repository

The Node shape cannot judge Python source. The harness runs inside a sealed sandbox with a pinned Node binary; it has no admitted route to launch an interpreter and evaluate `src/qe_evidence`. So `ccc-quant-engine` must use the Python profile.

That choice carries a consequence the contract never mentions: **candidate paths never reach the adapter's command line.** The Python command is exactly four tokens, and none of them is a candidate. `proof.candidateInputs` is still declared and still sealed into `candidateInputsSha256`, but the reciprocal check at `:348-355` that binds command arguments to declared candidates is inside the Node branch only — the Python branch returns at `:343` before reaching it.

Therefore the adapter must locate the code under test by itself. See Section 2 for exactly what that means it has to do.

### Per-target rundown at the pinned baseline

`Taskfile.yml` at `c29171c2` declares seven verify-shaped targets. Every one refuses, and most refuse several ways at once. Each row lists independent disqualifications; fixing one would not rescue the target.

| Target | Disqualifications |
|---|---|
| `verify:deps` | `desc` key present; two `cmds` entries; second entry is `- task: verify:validation-install`; `${QE_DEPENDENCY_LEDGER:-...}` substitution (banned `$`, `{`, `}`); double quotes; `uv` as `tokens[0]` |
| `verify:validation-install` | `desc` key; single cmd but 9 tokens beginning `uv`, not 4 beginning `python3` |
| `verify:validation-oracle` | `desc` key; `PYTHONPATH=src` and `PYTHONDONTWRITEBYTECODE=1` carry `=`; `no:cacheprovider` carries `:`; `uv`; `-m pytest` runs model-owned tests |
| `verify` | Key is `verify`, which fails `VERIFY_TARGET = /^verify:[a-z0-9][a-z0-9:-]{0,63}$/u` (`:28`) because there is no slug after the colon; five `- task:` entries. Also unreachable — `PROOF_COMMAND` (`:29`) only accepts `task verify:<slug>` |
| `verify:m0` | `desc` key; three `cmds`, first two are `- task:` deps; third carries `"` and `=`; `uv`; `-m pytest` |
| `verify:m1` | same as `verify:m0` |
| `verify:m2` | same as `verify:m0` |

Three enforcement details behind that table are worth stating on their own, because none is documented:

1. **`desc` is forbidden on the selected target.** `TARGET_KEYS = new Set(["cmds"])` (`:32`) and the loop at `:275-280` refuses every other key. The error message special-cases `deps` (`:277`), which makes it read as though dependencies are the concern. They are not the only concern — `desc` refuses identically, with the message `CCC semantic-proof Task target desc behavior is forbidden`. Every existing target in `ccc-quant-engine` carries `desc`.

2. **Root-level Taskfile keys are restricted to `version` and `tasks`** (`:31`, enforced `:312-316`). `ccc-quant-engine` happens to comply today. Adding `env:`, `dotenv:`, `includes:`, `vars:`, `output:`, or `silent:` at root would break *every* proof in the repository at once, not just one target.

3. **Parse-level strictness is global even though shape-checking is not.** `assertNoAliases` walks the entire document (`:252-265`), so any YAML anchor or alias anywhere in the file refuses. `parseDocument` runs with `strict: true, uniqueKeys: true`, and `document.warnings.length > 0` refuses just as hard as an error (`:307`). Only the *selected* target gets the `cmds`-only shape check, so unselected targets keep their `desc` and `deps` freely.

### Literal conforming Taskfile text

This is the exact text required for the draft PRD's four proof targets. Note the absence of `desc`, the single `cmds` entry per target, the four space-separated tokens, and that every token matches `[A-Za-z0-9._/-]+`.

```yaml
version: "3"

tasks:
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

These four stanzas are added to the existing `Taskfile.yml` alongside the current targets. The existing targets keep their `desc` and `deps` and continue to work as ordinary developer commands; they are simply never selectable as proof authority.

## Section 2 — The prerequisite commit

### Confirmed: closure is read from the baseline commit

`hydrateProof` reads every verifier-closure entry with `gitBytes(repositoryRoot, input.baseCommit, path)` (`packages/core/src/ccc-prd/semantic-proof-custody.ts:1301`). Not the working tree, not `HEAD` — the pinned baseline commit. It then derives each blob's Git OID and SHA-256 and seals them into the proof.

Separately, `assertClosureDisjoint` (`:1266-1278`) refuses any closure entry that is the same as, contains, or is contained by any model write root, checked in both directions:

```
if (isSameOrWithin(entry.path, root) || isSameOrWithin(root, entry.path)) custodyRefusal(...)
```

And exactly one closure entry must carry role `task_runner`, with the literal path `Taskfile.yml` (`:1310-1313`).

Those three rules close the loop. The harness must be a Git blob at the pinned baseline, and it must live outside everything the campaign is allowed to write. **A campaign cannot author its own verifier, and cannot author it into any location the verifier would then accept.** The conforming target and its harness must be committed to the target repository before the packet is frozen.

### What the prerequisite commit must contain

Enough detail here to make the commit from this description alone. Every path is relative to the `ccc-quant-engine` repository root. The commit lands on whatever branch the baseline is then pinned to, and the PRD's `Baseline commit:` line is updated to that new 40-hex SHA.

**1. `Taskfile.yml` — append the four stanzas from Section 1.**

Do not touch the existing targets. Do not add any root-level key beyond `version` and `tasks`. Do not introduce YAML anchors or aliases anywhere in the file. Verify the file parses with no warnings under a strict YAML parser with unique-key checking.

**2. `verify/qe_evidence_adapter.py` — the single harness.**

One self-contained file, standard library only. It is the sole `harness` closure entry and is referenced identically by all four targets. It must not shell out, must not invoke `uv`, must not use `-m`, must not use absolute paths, and must not rely on an ambient interpreter — that constraint is stated once, in `packages/engine/src/ccc-prd/native-authoring-adapter.ts:228`, and appears in no document.

**3. Four case directories, each with at least one file.**

```
verify/cases/labels/cases.json
verify/cases/verdict/cases.json
verify/cases/candidate/cases.json
verify/cases/integrated/cases.json
```

Each is declared as a `fixture` closure entry. The requirement is structural: for each proof, at least one fixture path must begin with that proof's `targetPath` followed by `/` (`:339`). These files hold the expected inputs and outputs — they are the oracle, and they are the reason the PRD's acceptance clauses describe contracts rather than enumerating cases.

**4. Nothing under `src/qe_evidence/`.**

That path is the model write root. A baseline file anywhere inside it would trip `assertClosureDisjoint` in the containment direction and refuse every proof in the packet. The directory must not exist at the baseline.

**5. Nothing else.**

Do not pre-create `src/qe_evidence/__init__.py` as a convenience. Do not add tests. Do not touch `pyproject.toml` or `uv.lock` — the adapter is stdlib-only precisely so that no dependency change is needed.

### What the adapter script has to do

Because candidate paths never reach its command line, the adapter is responsible for finding the code under test. Concretely:

1. **Parse exactly one argument pair**, `--target <dir>`, and resolve it relative to the current working directory. Nothing else arrives on `argv`.

2. **Put the source root on the import path itself.** The repository runs its own tests with `PYTHONPATH=src`, but the proof command cannot carry an environment prefix — `=` is outside the token charset. So the adapter must do the equivalent in code, inserting `src` at the front of `sys.path` before importing.

3. **Import the candidate module by a path it hardcodes**, not one it receives. For this packet that is `qe_evidence`, resolving to `src/qe_evidence/labels.py`, `src/qe_evidence/verdict.py`, and `src/qe_evidence/__init__.py`. The hardcoding is unavoidable under the Python profile and is safe, because the adapter is baseline-owned and the model cannot edit it.

4. **Fail loudly on a missing or unimportable candidate.** A campaign that writes nothing must produce a nonzero exit, not a vacuous pass. This is the single most important behavior in the file: the sandbox will happily run an adapter that imports nothing and exits zero, and that is a silent false green.

5. **Load its cases from the `--target` directory and judge behavior, not implementation.** Read the fixture file, call the public functions, compare against expected results. Do not inspect source text, do not import the model's tests, do not accept a result merely because it is internally consistent.

6. **Enforce the negative controls declared in the PRD.** For this packet: reject a result that drops an input label, admits an unadmitted label, returns a non-canonical order, promotes without `POINT_IN_TIME_PROVIDER`, promotes while a disqualifying label is present, promotes with an unmet or misnamed gate, or omits a blocking reason for an unmet condition. A harness that only checks the happy path is not a proof.

7. **Verify the stdlib-only constraint for the integrated target.** Inspect `sys.modules` after import, or walk the module's imports, and refuse any third-party or first-party `qe_*` dependency. This is a declared clause and needs a real check.

8. **Exit 0 on complete success and nonzero on any failure**, with a concise diagnostic on stderr. Exit code is the entire proof signal.

9. **Be deterministic.** No clock, no randomness, no network, no writes outside what the sandbox permits. Two runs against the same candidate commit must produce the same verdict.

### Residual unknown

The Python profile seals an entire interpreter runtime — interpreter, stdlib root, site-packages roots, extension-module roots, runtime support, and dylib closure — under caps of 16 roots, 200,000 files, and 1 GiB (`packages/core/src/ccc-prd/semantic-proof-custody.ts:38-42`). I specified the new package as stdlib-only largely to keep this tractable, but I have no evidence the discovery path has ever been run against this repository's uv environment. This is the largest untested surface in the whole route.

## Section 3 — Contract-versus-code disagreements

The spec for fixing the documentation. Each entry gives the doc claim, the code reality, and the enforcing location.

### 3.1 `the verifier command` is a lint rule, not an intake rule

- **Doc claim** — `docs/ccc-prd-intake-contract.md:50`: "write `the verifier command task verify:slugify` inside the proof's cited source text. The exact lower-case words `the verifier command` are deliberate."
- **Code reality** — the phrase is required only by `fn prd lint`, which is explicitly advisory (`optionalContract: true`, and `docs/ccc-prd-intake-contract.md:86` says "Lint is guidance, not campaign admission"). The proof-command grammar that actually gates admission is `CCC_CAMPAIGN_TASK_VERIFY_DECLARATION_PATTERN_SOURCE`, which contains no such phrase. The Gate 2 packet passes real intake and writes `For this task, task verify:contract establishes…`, never containing the words.
- **Enforcing code** — `packages/engine/src/ccc-prd/intake-contract.ts:223`.
- **Impact** — an author reading the contract believes a lint rule is an admission rule. Harmless in itself, but it teaches false confidence about which document is authoritative.

### 3.2 The doc overstates what must live inside a proof's cited span

- **Doc claim** — `docs/ccc-prd-intake-contract.md:50`: "The sidecar's exact `proof.command` value must appear literally inside that same cited span, together with its accepted clause IDs, task/final phases, positive cases, negative controls, trusted verifier-closure paths, and candidate input paths."
- **Code reality** — exactly three values are span-bound: `command`, `positiveOracle`, and each negative-control `description`. Clause IDs, phases, positive-case descriptions, closure paths, and candidate paths are never checked against the span.
- **Enforcing code** — `packages/engine/src/ccc-prd/authoring.ts:746-777`. Compare the requirement binding at `:735-745` and the protected-action binding at `:778-794`, which are the only other entity-scoped bindings.
- **Impact** — bidirectional and both bad. An author following the prose does substantially more work than required. An author following the code could ship a span the prose declares insufficient and be unable to tell whether a future version will start enforcing it.

### 3.3 `fn prd template` emits a document that cannot pass material coverage

- **Doc claim** — `docs/ccc-prd-intake-contract.md:5`: "Run `fn prd template` to print the recommended Markdown shape." The template is presented as the starting point for a new executable PRD.
- **Code reality** — the template emits `## Constraints and dependencies`, `## Risks`, and `## Open questions`, each a heading with a body. Every heading with a non-empty immediate body becomes a material item requiring a disposition. None of those three matches the deferred or out-of-scope heading matchers, and none has a plausible requirement, task, or unresolved-decision span over it. All three land in `missing` and refuse.
- **Enforcing code** — template at `packages/engine/src/ccc-prd/intake-contract.ts:30-87`; inventory construction at `packages/engine/src/ccc-prd/material-coverage.ts:232-257`; disposition matchers at `:68-86`; the `missing` branch at `:406-408`.
- **Impact** — this is the highest-severity item in this document. The tool's own scaffold produces a refusal, and lint separately *recommends* the very sections the compiler punishes (`intake-contract.ts:238-261`). An author who follows both pieces of official guidance is guaranteed to fail.
- **Verified** — the draft PRD omits Risks and Open questions for exactly this reason and consequently carries two non-blocking advisories, `CCC_PRD_RISKS_RECOMMENDED` and `CCC_PRD_OPEN_QUESTIONS_RECOMMENDED`.

### 3.4 The `deps` error message misdirects

- **Doc claim** — `docs/ccc-prd-intake-contract.md:52` lists what is not admitted: "Includes, dependencies, dotenv, variables, shell substitution, package-script indirection, dynamic dispatch, undeclared helpers, and model-owned tests."
- **Code reality** — the rule is an allowlist, not a denylist. `TARGET_KEYS = new Set(["cmds"])` permits one key and refuses every other, `desc` included. The error message special-cases `deps` and otherwise interpolates the offending key name, producing `CCC semantic-proof Task target desc behavior is forbidden` — which reads like a schema quirk rather than "delete your description."
- **Enforcing code** — `packages/core/src/ccc-prd/semantic-proof-custody.ts:32`, `:275-280`.
- **Impact** — the doc's denylist framing invites an author to check their target against a list and conclude it is fine. The real question is whether the target has any key other than `cmds`.

### 3.5 The doc never mentions the Python profile

- **Doc claim** — `docs/ccc-prd-intake-contract.md:52`: "The verifier target must be one literal Task command invoking the admitted Node executable, the one declared harness, and the literal candidate paths."
- **Code reality** — there are two profiles. The Python profile (`ccc-prd.verifier.python-adapter.v1`) accepts `python3 <adapter> --target <target>` and does *not* place candidate paths on the command line at all. For a Python target repository it is the only workable route, and the contract does not acknowledge it exists.
- **Enforcing code** — `packages/core/src/ccc-prd/semantic-proof-custody.ts:231-249`, `:323-343`; type at `packages/core/src/ccc-prd/types.ts:20`.
- **Impact** — an author reading only the contract concludes that a Python repository cannot be a Fusion target. That is wrong, and it is the kind of wrong that stops a project rather than merely slowing it.

### 3.6 Root-level Taskfile key restriction is undocumented

- **Doc claim** — none. The contract discusses the verify target and its closure; it says nothing about the rest of the file.
- **Code reality** — only `version` and `tasks` are permitted at root. Any other root key refuses, for every proof in the packet.
- **Enforcing code** — `packages/core/src/ccc-prd/semantic-proof-custody.ts:31`, `:312-316`.
- **Impact** — a target repository that later adds `dotenv:` or `vars:` for unrelated reasons silently loses the ability to host any campaign. Nothing warns about this.

### 3.7 Global YAML strictness is undocumented

- **Doc claim** — none.
- **Code reality** — `assertNoAliases` walks the whole document; any anchor or alias anywhere refuses. `parseDocument` runs strict with unique-key checking, and `document.warnings.length > 0` refuses as hard as an error.
- **Enforcing code** — `packages/core/src/ccc-prd/semantic-proof-custody.ts:252-265`, `:303-308`.
- **Impact** — a YAML feature used in an unrelated part of the Taskfile can break every proof, with an error that names YAML rather than the feature.

### 3.8 `Allowed write roots` and `Allowed write root` are different labels

- **Doc claim** — the contract and template both speak of "Allowed write roots" as a single concept (`intake-contract.ts:40` in the template).
- **Code reality** — two independent matchers over two different label lists. Lint accepts `Allowed write roots` / `Allowed paths` / `Writable paths`. Provenance accepts `Allowed write root` / `Admitted write root`, wants an *absolute* path, and separately requires an `Allowed write root purpose` line. Both matchers are prefix-based, so the plural line does not satisfy the singular label — the character after `root` is `s`, and the prefix check fails.
- **Enforcing code** — lint at `packages/engine/src/ccc-prd/intake-contract.ts:170-179`; provenance at `packages/engine/src/ccc-prd/authoring.ts:710-727`, via `requireTopLevelBinding` at `:631-643` and the label scan at `:533-583`.
- **Impact** — a correct PRD must carry both a plural line and one or more singular lines that look redundant and are not. Lines 20-21 of the draft PRD exist for this reason.

### 3.9 The provenance fallback requires global uniqueness

- **Doc claim** — `docs/ccc-prd-intake-contract.md:24`: facts must "cite admitted source bytes and hashes." No mention of uniqueness.
- **Code reality** — when no labeled line matches, `findFactBindingInSource` falls back to a raw byte search across all sources and returns `undefined` if the needle occurs more than once. The resulting diagnostic names the fact, not the ambiguity.
- **Enforcing code** — `packages/engine/src/ccc-prd/authoring.ts:584-600`.
- **Impact** — a non-goal or write-root purpose that happens to appear twice in the document binds to nothing, and the refusal message gives no hint why. The draft avoids this by using explicit labels for every fact.

### 3.10 `positiveCases[0].description` is unbound

- **Doc claim** — `docs/ccc-prd-intake-contract.md:50` lists "positive cases" among the values that must appear in the proof's span.
- **Code reality** — never checked. Gate 2 sets `positiveCases[0].description` equal to `positiveOracle`, so it is span-covered by coincidence rather than by rule.
- **Enforcing code** — the absence is in `packages/engine/src/ccc-prd/authoring.ts:746-777`; shape-only validation at `packages/engine/src/ccc-prd/compiler.ts:491`.
- **Impact** — a proposal with a distinct positive-case description passes provenance and lands in the packet unbound to any source bytes.

### 3.11 Only three entity kinds discharge a coverage obligation

- **Doc claim** — `docs/ccc-prd-intake-contract.md:86`: "a material-coverage disposition for every significant section or requirement." The mechanism is not described.
- **Code reality** — a material item is covered only by an overlapping *requirement* span, an overlapping *task* span, a task whose `requirementIds` intersect a matching requirement, an overlapping *unresolved-decision* span, or an explicit deferral or out-of-scope heading. Proof spans and protected-action spans do not count, despite being real cited source evidence.
- **Enforcing code** — `packages/engine/src/ccc-prd/material-coverage.ts:334-345`.
- **Impact** — this is the rule that makes narrative sections fragile, and it is invisible. A section can be cited by a proof and still refuse as `missing`.

### 3.12 Every accepted clause needs final-integrated proof coverage

- **Doc claim** — `docs/ccc-prd-intake-contract.md:74` mentions that "the final integrated proof set reruns against the exact combined commit/tree before merge approval," phrased as a runtime behavior.
- **Code reality** — it is a compile-time structural requirement. Every accepted clause must be claimed by at least one proof whose `phases` includes `final_integrated`, or compilation emits `CCC_PRD_ACCEPTANCE_CLAUSE_UNDISPOSITIONED`. Clause-to-proof linkage must also be reciprocal in both directions.
- **Enforcing code** — `packages/engine/src/ccc-prd/compiler.ts:1687-1698`; reciprocity at `packages/engine/src/ccc-prd/acceptance-clauses.ts:582-596`.
- **Impact** — an author who writes per-task proofs and no integrated proof produces a packet that parses cleanly and then refuses at compile.

### 3.13 The clause grammar is stricter than "one physical line"

- **Doc claim** — `docs/ccc-prd-intake-contract.md:35`: "Each clause is one physical UTF-8 line."
- **Code reality** — additionally: a trailing space or tab on a clause line refuses; any non-empty line inside an `#### Acceptance clauses` block that does not match the bullet pattern refuses as "malformed or continued"; an `AC-`-prefixed bullet outside an acceptance subsection refuses; a clause ID must be exactly `AC-<requirementId>-<suffix>` with a non-empty canonical suffix; and any heading at all resets the subsection, so a clause list cannot be interrupted by a sub-heading and resumed.
- **Enforcing code** — `packages/engine/src/ccc-prd/acceptance-clauses.ts:61-66` (patterns), `:182-191` (heading reset, trailing whitespace), `:210` and `:234` (malformed or continued), `:235-237` (bullet outside subsection), `:119-129` (clause ownership).
- **Impact** — mostly benign, because the failures are loud and the message is specific. Listed for completeness.

## Section 4 — Difficulty estimate

Hard, and hard in a way that does not shrink with practice. Splitting it by what kind of work it actually was:

### Mechanical — a tool can do this outright, no judgment required

The clause grammar itself. `### Requirement <ID>`, then `#### Acceptance clauses`, then `- [AC-<ID>-NNN] <text>`, one physical line each, no trailing whitespace. Twenty minutes with `acceptance-clauses.ts` and it is fully understood, permanently.

The boilerplate around it, all of it unguessable and all of it derivable:

- the dual plural/singular write-root lines
- the absolute-versus-relative path split between them
- `Maximum duration in milliseconds` spelled exactly that way, with `Max duration ms` as the only alternative
- the `Non-goal:` prefix on each non-goal
- the `Requirement statement:` prefix on each statement line
- the proof-line template with command, oracle, and controls as literal substrings of one physical line
- the choice to leave container headings body-less so they generate no coverage obligation

None of this requires thought. All of it requires knowing a rule that is written down nowhere.

### Judgment — a human or a model must decide

Picking a backlog item that is genuinely designed-but-unbuilt rather than half-built. That took reading the run log, the status note, the change plan, and the design packet, then grepping the source to confirm the propagation logic really did not exist anywhere.

Deciding the module must be stdlib-only. That is partly good hygiene and mostly a consequence of the Python runtime manifest sealing the whole interpreter environment — a reason invisible from the PRD side.

Writing acceptance clauses precise enough to implement against but not so precise that they enumerate the fixture cases. That line is real, and several sentences moved across it during drafting. The rule I settled on: state the contract, never state a case.

Choosing a baseline when the designated one is empty and the two remaining candidates trade off differently — `main` is the default branch, `stage-c-baseline` is the active source and the only commit where the cited `EvidenceClass` vocabulary exists.

The disqualifying-label rule, which the design packet does not specify and which is a product decision belonging to Ryan.

### Discoverable only by reading parser source

This is most of the work, and it is the category that decides whether the bridge tool is worth building.

- `desc` refuses on a selected target. Stated nowhere.
- `deps` refuses. Stated only as "dependencies… are not admitted," in a denylist that reads as exhaustive and is not.
- The command must be exactly four tokens beginning `python3`, or `node` plus candidates. The contract mentions only Node.
- The Python profile exists at all.
- Root Taskfile keys are restricted to `version` and `tasks`.
- Closure bytes are read from the baseline commit — the fact that makes a pre-freeze commit mandatory, and the single most consequential rule in the system.
- Closure must be disjoint from model write roots in both directions.
- `=` and `:` are outside the command token charset.
- Every heading with a body becomes a coverage obligation, and only requirement, task, and unresolved-decision spans discharge it.
- `Allowed write roots` and `Allowed write root` are separate labels with separate matchers.
- The provenance fallback requires global byte uniqueness.
- Every accepted clause needs final-integrated coverage.

The fatal one — that no admissible verify target exists anywhere in the target repository, and that the campaign cannot create one — was found by reading a regex, not a document. Ryan would never find it. He would write a lint-clean PRD, run freeze, and receive a refusal naming a YAML key.

### The honest summary

Admissibility is not stated in any single place. It is distributed across a prose contract that is wrong or silent in at least twelve ways, a lint module gating on different rules than the compiler, a coverage scorer whose failure mode is invisible until you simulate it, a provenance binder with label lists that appear in no documentation, and a proof-custody module that silently invalidates the target repository's entire existing verification surface.

A document can be perfectly grammatical, lint-clean, and still refuse. That is the core problem, and no amount of authoring skill fixes it — only tooling does.

### What an authoring-assist tool must do, in value order

1. **Audit the target repository's `Taskfile.yml` first, and refuse early.** Parse every `verify:*` target through the real `verifyStrictTaskTarget`. If none is admissible — which is the normal case, not the exception — say so before any authoring begins, and emit the conforming Taskfile stanza plus an adapter skeleton the operator must commit pre-freeze. This alone is the difference between a five-minute answer and a five-hour investigation. It is also the only step that catches the failure that stops projects.

2. **Run the real scorers, not a checklist.** Everything validated for the draft PRD is roughly 150 lines against the already-built `packages/engine/dist/`. Show the author the material inventory with each item marked covered or missing, before freeze. The scorer's own source comments (`material-coverage.ts:52-67`) warn that silent under-coverage is the dangerous direction; the author should never be the one to discover it.

3. **Generate the unguessable boilerplate.** Everything in the mechanical list above. The author supplies meaning; the tool supplies the exact bytes.

4. **Render the proof line from four fields.** Command, clause IDs, positive oracle, negative controls. The tool composes the single physical line so the literal-substring requirement cannot be violated by hand.

5. **Force an integrate task whenever narrative sections exist**, and wire its `sourceRefs` to them explicitly. Do not leave coverage of the product outcome to model discretion. This is what took the draft PRD from 4 missing sections to 0.

6. **Interview, do not validate.** Ryan can answer "what should someone be able to do when this is done?", "what would prove it?", "what must this never touch?" He cannot answer "does your requirement's cited span byte-contain its acceptance text?" Ask the first set; derive the second.

7. **Fix `renderCccPrdIntakeTemplate()`.** It currently ships three sections that guarantee a refusal. That is a bug in ccc-fusion, not a burden for the author.

## Section 5 — Where I am unsure the draft PRD is admissible

Ordered by how much it worries me.

**5.1 Narrative-section coverage rests on model discretion.** I simulated the coverage scorer with a Gate 2-shaped proposal. With two tasks citing only their own requirement, clause, proof, and protected-action lines, four sections went `missing`: Product outcome, the behavior contract, Final integrated proof, and Supporting context. Nothing in the grammar compels a task to quote them — Gate 2 survives only because `scripts/lib/ccc-gate2-telemetry-packet.mjs:99-106` hard-codes those extra quotes onto its integrate task. I added a third task for this reason and reached 19 of 19 covered, 0 missing, 0 conflicts. But the guarantee still depends on the understanding model choosing to cite those lines. This is the fragility I am least comfortable with, and it is a property of the system, not of the document.

**5.2 The Python runtime manifest is entirely unexercised.** See the residual unknown in Section 2. No evidence it has ever been run against this repository's environment.

**5.3 The operator-context conflict path is untested.** The contract says guided freeze compares against labeled facts in every authoritative source and refuses on conflict. The draft states target, baseline, and bounds inline. If someone runs `fn prd freeze` with `--target`, `--base`, or `--max-*` flags differing by a single character, I believe it refuses. I did not exercise that path.

**5.4 Whether a non-empty `unresolvedDecisions` list blocks executable intake.** It is a valid coverage disposition (`unresolved_question`, `material-coverage.ts:382-389`), which suggests `## Open questions` could be made coverable by declaring a real open question. I could not confirm that unresolved decisions do not block import elsewhere, so I omitted the section rather than risk it. Resolving this would let the template's three problem sections be rehabilitated rather than deleted.

**5.5 The disqualifying-label rule is my inference, not the design's.** The design packet lists `PROMOTABLE`'s preconditions but never says which labels disqualify. I wrote it as "any admitted label other than `POINT_IN_TIME_PROVIDER`, `PAPER_OBSERVATION`, and `PROMOTABLE`," reasoning from "operational evidence; never execution proof" that paper observation blocks execution but not human-review candidacy. This is a product decision and belongs to Ryan, not to me.

**5.6 The baseline pin is a judgment call.** `c29171c20d0707a419ee0355b5c53198c9baca3f` is the `agent/stage-c-baseline` tip — the active source per the 2026-08-25 status note, and the only commit where the cited `EvidenceClass` vocabulary exists. The v0.5.0 change plan instead names `97ff3a1159cf90efb386bb78a8f7222533f0758e` as the intended base for new chunks, but `src/qe_market_data` does not exist there, so the label vocabulary would have to be invented rather than cited. Either is defensible; the pin is a one-line change. Note that both are moot until the prerequisite commit from Section 2 lands, since that commit creates a new baseline SHA regardless.

**5.7 Everything past coverage and provenance is unverified.** Verifier hydration, toolchain sealing, execution-plan generation, preview, and import were not exercised. No `fn prd` command was run.

### What was verified, and how

Three parsers imported read-only from `packages/engine/dist/ccc-prd/` in a scratchpad script, run against the draft PRD's actual bytes:

```
lint readyForIntake: true | blocking: [] | advisories: [RISKS, OPEN_QUESTIONS]
clauses: 5 parsed, 0 dispositions, correct requirement ownership
material coverage: inventory=19 covered=19 missing=0 conflicts=0
provenance: all facts bound, 0 diagnostics
```

The provenance run exercised `computeCccPrdImplementationFactProvenance` with a full Gate 2-shaped fact set: target repository, baseline commit, all three execution bounds, both admitted write roots and their purposes, all five non-goals, three requirement acceptance bindings, four proof command/oracle/negative-control bindings, and four protected-action kind and target bindings. All bound with zero diagnostics.
