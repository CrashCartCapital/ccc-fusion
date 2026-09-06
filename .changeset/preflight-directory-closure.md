---
"@runfusion/fusion": patch
---

summary: The proof-verifier preflight now creates a not-yet-written candidate's parent directory chain, so a conforming verifier sees the same "src/ present, file absent" tree a live proof attempt always produces once any candidate exists — never "src/ absent entirely," a state live can never reach.
category: fix
dev: `admitAndMaterializeCccSemanticProof`'s `allowMissingCandidates` branch (packages/engine/src/ccc-campaign-proof-materialization.ts) now `mkdir -p`s the skipped candidate's dirname under `proofRoot`, reusing the directory half of `materialize()` without writing the file. Fixes a live refusal (`CCC_PRD_PROOF_VERIFIER_NONCONFORMING`) against a verifier whose own harness-vs-candidate distinction (missing directory = harness defect; missing file inside an existing directory = graded failure) is correct against a real checkout but was broken by Fusion's closure-only preflight tree.
