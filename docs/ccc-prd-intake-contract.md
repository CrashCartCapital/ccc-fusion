# CCC PRD Intake Contract

This is an optional authoring contract for future PRDs. Existing Markdown PRDs do not need to be rewritten when Fusion can extract their meaning safely. Fusion freezes the original source packet and writes semantic decisions to a hash-bound sidecar; it never silently edits the PRD.

Run `fn prd template` to print the recommended Markdown shape. Run `fn prd lint <prd-path>` to report missing facts. Lint is read-only.

## Project boundary

Discovery selects the current PRD inside each top-level project directory under the configured active-projects root. Markdown files placed directly at that root are portfolio trackers, process guidance, or shared context; they are not implementation packets because they do not provide a project-local repository and support-document boundary. Fusion ignores them during discovery and refuses an explicit freeze with an actionable message. Move or copy a genuine implementation PRD into its project directory only through the normal reviewed vault workflow; Fusion never moves or rewrites the source.

## Facts Fusion must not guess

A PRD is not ready for implementation intake until it identifies:

- the target repository;
- one exact 40-hex baseline commit;
- target-relative allowed write roots;
- observable acceptance behavior;
- the verifier or other expected proof;
- protected actions that require operator approval, or an explicit `None`.

Missing facts become blocking questions. The operator can answer them in a reviewed sidecar or successor PRD; the original source remains unchanged.

For the supported product route, every implementation-changing fact must also have exact-span custody in the frozen packet. Fusion records the target path and baseline, allowed write-root paths and purposes, execution bounds, non-goals, requirement acceptance behavior, proof commands and oracles, negative controls, and protected-action kinds and targets in `implementationFactProvenance`. Each recorded value cites admitted source bytes and hashes. Requirement and proof facts must appear inside that entity's cited source span; a matching phrase elsewhere in the PRD is not enough.

Operator decisions can supply missing facts only when they are admitted into the frozen packet as a reviewed source. CLI flags and transient prompts are constraints, not source facts.

## Recommended structure

The template also recommends product outcome, requirements with stable IDs, constraints and dependencies, non-goals, risks, and open questions. These sections improve extraction quality but do not replace source citations, material-section coverage, or compiler validation.

## Relationship to admission

Lint is guidance, not campaign admission. A supported import still requires a frozen packet, exact source hashes, a material-coverage disposition for every significant section or requirement, a complete execution policy, target/baseline checks, compiler provenance, preview confirmation, and the transactional importer.
