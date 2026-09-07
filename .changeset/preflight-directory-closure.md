---
"@runfusion/fusion": patch
---

summary: Fix the proof-verifier preflight to create a not-yet-written candidate's parent directory.
category: fix
dev: `admitAndMaterializeCccSemanticProof`'s `allowMissingCandidates` branch (packages/engine/src/ccc-campaign-proof-materialization.ts) now `mkdir -p`s the skipped candidate's dirname under `proofRoot` (through the shared `resolveWithinCccSemanticProofRoot` containment guard), reusing the directory half of `materialize()` without writing the file. Fixes a live refusal (`CCC_PRD_PROOF_VERIFIER_NONCONFORMING`) against a verifier whose own harness-vs-candidate distinction (missing directory = harness defect; missing file inside an existing directory = graded failure) is correct against a real checkout but was broken by Fusion's closure-only preflight tree.
