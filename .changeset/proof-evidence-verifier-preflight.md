---
"@fusion/engine": minor
"@runfusion/fusion": minor
---

summary: Refuse a non-conforming proof verifier at preview/import instead of only after a live task burns a real attempt.
category: feature
dev: `fn prd preview`/`fn prd import` now run every declared v2 proof's verify command against the pinned base commit, in the same sealed materialize-then-sandbox path a live attempt uses (`admitAndMaterializeCccSemanticProof` + `verifyCccSemanticProofToolchainBeforeSpawn` + the semantic-proof sandbox), and judge stdout with the exact same `parseSemanticProofEvidence`/`semanticProofEnvelope` a live proof attempt uses — never a second parser. No candidate implementation exists yet at preview/import time, so materialization gained an opt-in `allowMissingCandidates` flag (default `false`, unchanged for the real per-attempt path) that tolerates an absent candidate blob instead of refusing outright; a conforming verifier must still emit valid `ccc-prd.proof-evidence.v2` JSON in that state. A refusal now surfaces the structured code `CCC_PRD_PROOF_VERIFIER_NONCONFORMING`, naming the proof, the parse warning, and the first line of stdout. Also splits the evidence-parser's collapsed `not-canonical-json` reason into `not-json` (stdout was never JSON syntax at all) and `not-canonical-json` (a successful parse that is merely non-canonical byte form) — the two are different defect classes and the collapsed reason hid a verifier that never emits the contract behind what read as a formatting nit.
