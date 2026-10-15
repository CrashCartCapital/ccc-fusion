# Errata E11: post-repair verdicts on the early I2 cards, and GG's final repair

Date: 2026-10-14. Precedence: E11 > E10 > E9 > v3.5.

## Verdicts

- **RP: ACCEPTED** at 34eaa9ab5 (cheap lane; two independent post-repair reviews both ACCEPT).
- **IP: ACCEPTED** at d48a723a0 (normal lane, fresh Opus review).
- **IB1: ACCEPTED** at 96d252cbc (normal lane; two independent post-repair reviews both ACCEPT).
- **GG: REPAIR** at d010a8590. The reviewer and the adversary both found gaps.
  - GG goes to **repair 2 of 2, its final repair**, followed by a fresh critical review: an Opus reviewer plus an Opus adversary.
  - If repair 2 fails, the leader re-plans the residual as card GGz.

## GG repair 2 (binding)

1. **Per-field pins for `write-root-canonical`** (review fix, also adversary item 2). Add the reviewer's test, which puts the bad spelling in exactly one field: either `ownedPaths` only or `allowedWriteRoots` only, both non-canonical and padded. The diagnostic must name that field. Mutants R7, R8, R9, R10 and W1 must now fail. `cards/gg.mjs` names stay exact.
2. **G4 mirrors the importer's two route rules** (adversary item 1, adopted). G4 promises that a plan it admits is not refused after review (section 2.17), so it must check what `parseCccCampaignProductExecutionPolicy` checks (core `ccc-campaign/canonical.ts` `parseProductRoute`, about :483-500). For each task:
   - (a) Every `allowedWriteRoots` entry `r` satisfies, as exact strings, `r === o` or `r.startsWith(o + "/")` for some `ownedPaths` entry `o` of the same task.
   - (b) `resolve(target.path, r)` lies inside some PRD-admitted write root, using the semantics of the importer's `filesystemPathContains`. Reuse the importer's helper if core exports it; otherwise mirror it and pin the result with a test against the real parser.
   - Each violation is one `CCC_PLANNING_GRAPH_INADMISSIBLE` diagnostic that names the task, the path and the rule. Use new rule names, for example `write-root-within-owned` and `write-root-admitted`.
   - REDs: P2 (a diamond whose admitted roots omit `bin/`) and P3b (`SRC/tokenizer.mjs` as a root next to the owned path `src/tokenizer.mjs`), each with a control.
   - Change the test fixtures (the graph-gate `ADMISSION_FACTS` and `proposal().admittedWriteRoots`) to admit `<target>/src` and `<target>/bin`.
   - The positive control must also prove the proposal's routes pass the real `parseCccCampaignProductExecutionPolicy`, imported from `@fusion/core`. Core exports it through `ccc-campaign/index.ts`; confirm the package barrel re-exports it, and if it does not, report that rather than editing a barrel.
3. **Exact-spelling pins** (adversary item 3, adopted).
   - REDs X4 (Taskfile target `node TEST/tokenizer.test.mjs ...` against the harness `test/tokenizer.test.mjs`) and X2 (closure harness `TEST/...` against the bundle file `test/...`), each with its exact-case twin as control. Mutants K4 and K2 must now fail.
   - Also pin the candidate-in-own-write-roots branch (mutant K1).
   - The FNXC comment stays: these comparisons are exact because custody admits only exact spellings. E2-13's comparison key governs overlap and identity, not custody spelling.
