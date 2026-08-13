# CCC PRD Intake Contract

This is the recommended authoring contract for new executable PRDs. Existing Markdown PRDs remain inspectable and can still produce a review-only understanding artifact, but Fusion does not grant them the new clause-complete semantic-proof status unless their source declares the v2 grammar below. Fusion freezes the original source packet and writes semantic decisions to a hash-bound sidecar; it never silently edits the PRD.

Run `fn prd template` to print the recommended Markdown shape. Run `fn prd lint <prd-path>` to report missing facts. Lint is read-only.

## Project boundary

Discovery selects the current PRD inside each top-level project directory under the configured active-projects root. Markdown files placed directly at that root are portfolio trackers, process guidance, or shared context; they are not implementation packets because they do not provide a project-local repository and support-document boundary. Fusion ignores them during discovery and refuses an explicit freeze with an actionable message. Move or copy a genuine implementation PRD into its project directory only through the normal reviewed vault workflow; Fusion never moves or rewrites the source.

## Facts Fusion must not guess

A PRD is not ready for implementation intake until it identifies:

- the target repository;
- one exact 40-hex baseline commit;
- target-relative task ownership and allowed write roots;
- observable acceptance behavior declared as exact, stable clause IDs;
- the verifier or other expected proof;
- protected actions that require operator approval, or an explicit `None`.

Missing facts become blocking questions. The operator can answer them in a reviewed sidecar or successor PRD; the original source remains unchanged.

For the supported product route, every implementation-changing fact must also have exact-span custody in the frozen packet. Fusion records the target path and baseline, task ownership, task write roots, admitted write-root paths and purposes, execution bounds, non-goals, requirement acceptance behavior, proof commands and oracles, negative controls, and protected-action kinds and targets in `implementationFactProvenance`. Each recorded value cites admitted source bytes and hashes. Requirement, proof, and task-custody facts must appear inside that entity's cited source span; a matching phrase elsewhere in the PRD is not enough.

### Exact acceptance-clause grammar

New executable packets declare acceptance authority in the source itself:

    ### Requirement REQ-001
    #### Acceptance clauses
    - [AC-REQ-001-001] The exact first behavior Fusion must prove.
    - [AC-REQ-001-002] The exact second behavior Fusion must prove.

Each clause is one physical UTF-8 line. The heading, subsection, requirement ID, and clause ID are literal grammar, not examples that may be paraphrased. Free-form acceptance prose can still help a human review, but it is not executable proof authority. Fusion refuses missing, duplicated, foreign, continued, unresolved, or silently omitted clauses before import.

An explicitly deferred or excluded clause stays under the same requirement and uses a separate subsection:

    #### Acceptance dispositions
    - [AC-REQ-001-003] deferred: The reviewed reason this behavior is not in this campaign.

An `unresolved` disposition blocks executable intake.

### Campaign proof commands and trusted inputs

An executable campaign proof must name a repository-owned Go Task target. The admitted declaration grammar is:

    ^task verify:[a-z0-9][a-z0-9:-]{0,63}(?: --(?: [a-z0-9][a-z0-9:._/-]{0,63}){0,8})?$

For example, write `the verifier command task verify:slugify` inside the proof's cited source text. The exact lower-case words `the verifier command` are deliberate. The sidecar's exact `proof.command` value must appear literally inside that same cited span, together with its accepted clause IDs, task/final phases, positive cases, negative controls, trusted verifier-closure paths, and candidate input paths. Repeating the command elsewhere in the PRD does not establish proof custody.

Trusted verifier closure means baseline-owned regular Git files that the model cannot edit: normally `Taskfile.yml`, one self-contained Node harness, and any fixed fixtures or configuration it reads. Candidate inputs are the model-owned implementation files the harness is allowed to judge. The verifier target must be one literal Task command invoking the admitted Node executable, the one declared harness, and the literal candidate paths. Includes, dependencies, dotenv, variables, shell substitution, package-script indirection, dynamic dispatch, undeclared helpers, and model-owned tests are not admitted as proof authority.

The AI may identify the intended closure paths and candidates. Fusion itself reads the frozen Git blobs, derives their object IDs and SHA-256 digests, resolves and hashes Task, Node, and the proof host, validates the Task target, and seals those observed identities. Model-supplied hashes or executable claims are never accepted merely because they are internally consistent.

Commands such as `npm test`, `pnpm test`, `pytest`, arbitrary executables, shell pipelines, redirection, and command substitution are not admitted directly. Put the required verification behind a repository `task verify:<slug>` target, then cite that exact declaration in the PRD.

Operator decisions can supply missing facts only when they are admitted into the frozen packet as a reviewed source. Raw CLI flags and transient prompts are constraints, not source facts; guided freeze promotes the reviewed values only by rendering, hashing, and receipting the companion described below.

## Guided intake for existing PRDs

When an existing PRD has the product decision but omits transient implementation facts, the normal freeze command can generate an authoritative companion without changing the source:

    fn prd freeze <active-projects-root> <selected-prd-path> <output-dir> --target <repository> --base <40-hex-commit> --owned-path <path> --write-root <path> --write-purpose <purpose> --max-requests <n> --max-duration-ms <n> --max-concurrency <n>

Repeat the owned-path and write-root flags for additional task custody. Automation can send the same exact ccc-prd.operator-context.v1 object through standard input:

    fn prd freeze <active-projects-root> <selected-prd-path> <output-dir> --context-stdin

Fusion validates the typed values, compares them with explicit labeled facts in every authoritative source, renders deterministic Markdown at sources/__fusion__/REF-HUM-FusionOperatorContext.md, and includes its bytes in the packet manifest, hash, and freeze receipt. A conflict, escaping path, incomplete context, oversized input, or invalid bound refuses before the output directory is published. The original PRD bytes remain unchanged. The companion records the reviewed source-write roots separately from Fusion's fixed target-local .fusion state-and-artifact root; coding tasks receive only their own reviewed roots. This companion can supply target, baseline, task custody, write-root purpose, and execution bounds; it cannot replace requirements, acceptance behavior, expected proof, non-goals, protected actions, or other missing product decisions.

## Current campaign shape

The supported CCC PRD product route freezes, compiles, previews, and imports hash-bound campaign material. Every task runs in an isolated worktree and must create a controller-checked commit. Its task-phase trusted proof must pass before dependent work is released. The final integrated proof set reruns against the exact combined commit/tree before merge approval. Chunked understanding remains a separate, serial extraction activity and does not itself grant execution authority.

Campaign execution is dependency-driven and admits independent roots, serial successors, and multi-predecessor joins only through the sealed graph, ownership leases, isolated worktrees, required commits, task proofs, and final proof gate. Chunk extraction and coding-campaign execution remain separate layers: serial chunk extraction can feed a parallel campaign plan without making extraction itself parallel.

The `--max-concurrency` value is an explicit safety envelope for one admitted run. It is not a permanent product worker ceiling, and it is not allowed to be "unlimited" in a packet. Larger parallel campaigns should be unlocked by empirical capacity evidence: hardware headroom, provider quota, worktree/storage limits, write-root collision checks, and final verification throughput.

## Recommended structure

The template also recommends product outcome, requirements with stable IDs, constraints and dependencies, non-goals, risks, and open questions. These sections improve extraction quality but do not replace source citations, material-section coverage, or compiler validation.

## Relationship to admission

Lint is guidance, not campaign admission. A supported import still requires a frozen packet, exact source hashes, clause-complete v2 semantics, a material-coverage disposition for every significant section or requirement, controller-derived verifier/toolchain custody, a hash-bound execution plan generated by `fn prd policy`, target/baseline checks, compiler provenance, preview confirmation, and the transactional importer. Preview and import refuse raw hand-written execution-policy JSON, semantic-v1 packets claiming new-product authority, or verifier identity that has drifted since authoring.
