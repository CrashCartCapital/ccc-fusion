# CCC PRD Intake Contract

This is an optional authoring contract for future PRDs. Existing Markdown PRDs do not need to be rewritten when Fusion can extract their meaning safely. Fusion freezes the original source packet and writes semantic decisions to a hash-bound sidecar; it never silently edits the PRD.

Run `fn prd template` to print the recommended Markdown shape. Run `fn prd lint <prd-path>` to report missing facts. Lint is read-only.

## Project boundary

Discovery selects the current PRD inside each top-level project directory under the configured active-projects root. Markdown files placed directly at that root are portfolio trackers, process guidance, or shared context; they are not implementation packets because they do not provide a project-local repository and support-document boundary. Fusion ignores them during discovery and refuses an explicit freeze with an actionable message. Move or copy a genuine implementation PRD into its project directory only through the normal reviewed vault workflow; Fusion never moves or rewrites the source.

## Facts Fusion must not guess

A PRD is not ready for implementation intake until it identifies:

- the target repository;
- one exact 40-hex baseline commit;
- target-relative task ownership and allowed write roots;
- observable acceptance behavior;
- the verifier or other expected proof;
- protected actions that require operator approval, or an explicit `None`.

Missing facts become blocking questions. The operator can answer them in a reviewed sidecar or successor PRD; the original source remains unchanged.

For the supported product route, every implementation-changing fact must also have exact-span custody in the frozen packet. Fusion records the target path and baseline, task ownership, task write roots, admitted write-root paths and purposes, execution bounds, non-goals, requirement acceptance behavior, proof commands and oracles, negative controls, and protected-action kinds and targets in `implementationFactProvenance`. Each recorded value cites admitted source bytes and hashes. Requirement, proof, and task-custody facts must appear inside that entity's cited source span; a matching phrase elsewhere in the PRD is not enough.

### Campaign proof commands

An executable campaign proof must name a repository-owned Go Task target. The admitted declaration grammar is:

    ^task verify:[a-z0-9][a-z0-9:-]{0,63}(?: --(?: [a-z0-9][a-z0-9:._/-]{0,63}){0,8})?$

For example, write `the verifier command task verify:slugify` inside the proof's cited source text. The sidecar's exact `proof.command` value must appear literally inside that same cited span, together with the positive oracle and negative controls. Repeating the command elsewhere in the PRD does not establish proof custody.

Commands such as `npm test`, `pnpm test`, `pytest`, arbitrary executables, shell pipelines, redirection, and command substitution are not admitted directly. Put the required verification behind a repository `task verify:<slug>` target, then cite that exact declaration in the PRD.

Operator decisions can supply missing facts only when they are admitted into the frozen packet as a reviewed source. Raw CLI flags and transient prompts are constraints, not source facts; guided freeze promotes the reviewed values only by rendering, hashing, and receipting the companion described below.

## Guided intake for existing PRDs

When an existing PRD has the product decision but omits transient implementation facts, the normal freeze command can generate an authoritative companion without changing the source:

    fn prd freeze <active-projects-root> <selected-prd-path> <output-dir> --target <repository> --base <40-hex-commit> --owned-path <path> --write-root <path> --write-purpose <purpose> --max-requests <n> --max-duration-ms <n> --max-concurrency <n>

Repeat the owned-path and write-root flags for additional task custody. Automation can send the same exact ccc-prd.operator-context.v1 object through standard input:

    fn prd freeze <active-projects-root> <selected-prd-path> <output-dir> --context-stdin

Fusion validates the typed values, compares them with explicit labeled facts in every authoritative source, renders deterministic Markdown at sources/__fusion__/REF-HUM-FusionOperatorContext.md, and includes its bytes in the packet manifest, hash, and freeze receipt. A conflict, escaping path, incomplete context, oversized input, or invalid bound refuses before the output directory is published. The original PRD bytes remain unchanged. The companion records the reviewed source-write roots separately from Fusion's fixed target-local .fusion state-and-artifact root; coding tasks receive only their own reviewed roots. This companion can supply target, baseline, task custody, write-root purpose, and execution bounds; it cannot replace requirements, acceptance behavior, expected proof, non-goals, protected actions, or other missing product decisions.

## Current vs. target campaign shape

Today's supported CCC PRD product route is still conservative: it can freeze, compile, preview, and import hash-bound campaign material, and the chunked understanding path remains serial unless a newer proof says otherwise. Do not read a requested execution bound as proof that arbitrary campaign-DAG parallelism is implemented.

The target campaign model is dependency-driven. A future campaign packet may describe multiple independent roots, successors, and multi-predecessor joins, but Fusion must admit and run that only when the planner, importer, scheduler, ownership leases, worker isolation, restart behavior, and verification gates have passing tests on the same tree. Chunk extraction and coding-campaign execution are separate layers: serial chunk extraction can feed a parallel campaign plan without making the extraction itself parallel.

The `--max-concurrency` value is an explicit safety envelope for one admitted run. It is not a permanent product worker ceiling, and it is not allowed to be "unlimited" in a packet. Larger parallel campaigns should be unlocked by empirical capacity evidence: hardware headroom, provider quota, worktree/storage limits, write-root collision checks, and final verification throughput.

## Recommended structure

The template also recommends product outcome, requirements with stable IDs, constraints and dependencies, non-goals, risks, and open questions. These sections improve extraction quality but do not replace source citations, material-section coverage, or compiler validation.

## Relationship to admission

Lint is guidance, not campaign admission. A supported import still requires a frozen packet, exact source hashes, a material-coverage disposition for every significant section or requirement, a hash-bound execution plan generated by `fn prd policy`, target/baseline checks, compiler provenance, preview confirmation, and the transactional importer. Preview and import refuse raw hand-written execution-policy JSON.
