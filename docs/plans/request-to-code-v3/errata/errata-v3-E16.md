# Errata E16: X1z lineage closed; GGz final repair

Date: 2026-10-15. Precedence: E16 > E15 > E14 > E13 > E12 > E11 > E10 > E9 > v3.5.

## Verdicts

- **X1z: ACCEPTED** at 56139aaa9 (repair 2 of 2). The fresh Opus reviewer and the fresh Opus adversary both returned ACCEPT. It integrates at INT-3c. With C2 and H1, it is one of the three prerequisites for SF.
  - Recorded follow-up (test gap, not blocking): the probe-list pin covers only the `required` tool list. A mutant that gives the `optional` loop, or a role-tool fallback, extra directories when searchPath is absent survives. The next card that owns `ccc-toolchain-discovery.darwin.test.ts` adds `discoverCccToolchain({ required: [], optional: [<random>] })` with the same probe assertion.
  - Recorded design residual: /opt/homebrew is owned by the operator account, so E6-0's Homebrew-only default is itself writable by the operator. This was chosen deliberately in E6-0.
- **GGz: REPAIR** at 0e0bae81a.
  - Build 924df6a37: review REPAIR (NFD closure paths), adversary ACCEPT.
  - Repair 1 0e0bae81a: review ACCEPT, adversary REPAIR (one finding).
  - GGz gets **repair 2 of 2 (final)**, then a fresh critical review. If that fails, the leader integrates the bytes when nothing regresses and re-plans the residuals as GGzz.

## GGz repair 2 (binding)

All items are in the same class as E12 item 1: closure paths G4 admits that the importer, compiler or custody check can never accept. Each item gets a RED that fails on 0e0bae81a and a control. Each item is pinned against the real function it mirrors.

1. **Ill-formed Unicode** (adversary 2, adopted).
   - Under rule `closure-path-git-literal`, refuse any verifier closure path where `!path.isWellFormed()` (Node 24 on the I2 host).
   - RED: `fixtures/\ud800.txt`. G4 refuses it with exactly one diagnostic, and the real `hydrateCccPrdSemanticProofV2Custody` refuses it on a temp repository.
   - Control: `fixtures/�.txt`. G4 and custody both admit it.
   - Evidence: scratchpad/adv2-ggz (probe1.out, lstree_probe2.mjs, plumbing_probe.mjs).
2. **Compiler source-path parity** (review 1 note, adopted).
   - The compiler's `isCanonicalRootRelativeSource` (engine `ccc-prd/compiler.ts:93-105`, used for closure entries at :515 and :538) refuses:
     - a value that is not trimmed;
     - a value containing a backslash or NUL;
     - a value starting with `file:` in any letter case;
     - an absolute path (posix or win32);
     - a value with an empty, `.` or `..` segment.
   - G4 must refuse every such verifier closure path before review spend. GGz does not own `compiler.ts`, so it mirrors the predicate, cites the lines in the FNXC, and pins each refused shape against the real compiler through its public entry point (the same compile path IB2 uses).
   - RED: `File:data.json`. Control: `fixtures/file-data.json`.
   - Where an existing G4 rule already refuses a shape, the pin still shows the compiler refusing it.
3. **Pin the proposal-side entity-id rows and workflow gating** (both reviewers' notes, adopted). Each test is hand-built because IB1 cannot build the shape, and says so in a comment.
   - Change the IB1 proposal's workflow id to `WORKFLOW PLANNING`. G4 refuses it under `import-entity-id`, and the real `assertCccPrdImportBundle` refuses it.
   - A task whose `workflowId` differs from the workflow is refused by `workflow-gates-every-task`, and the refusal names that task (fix the message).
   - A task listed twice is refused under that rule's duplicate check.
4. **FNXC corrections** (no behaviour change).
   - The NFC rule also over-refuses on Darwin some names that git's precompose leaves alone: U+212B, U+2126, U+212A, U+F900, and decomposed Kaithi U+110A5 U+110BA. This fails closed and is accepted, the same kind as K1's I/ı residual. State it.
   - D20 builds B1 with plumbing. State that the NFD refusal holds for both a working-tree commit and a plumbing commit. Check this with the adversary's plumbing probe, and correct any text that says B1 is committed through a working tree.
   - gg.mjs: "four custody cases" becomes the true count.
   - The unexplained 40 s custody stall: if it recurs during this repair, capture where it hangs. Never widen a timeout.

- **Check:** the E12 five-file command (unchanged).
- **Regression:** `cards/b2.mjs` and `cards/ib1.mjs` tests, unchanged.

## Accepted residuals (not GGz items)

- Closure directories that differ only in letter case (`fixtures/a.txt` and `FIXTURES/b.txt`). Custody admits them when B1 is built with plumbing (D20). Folding directory names belongs to K1 and VP. Recorded for VP.
- The non-Darwin branch of the NFD custody test runs for the first time in the ci-linux Gate lane. The card is platform `any`.
