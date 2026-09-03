# CCC-Fusion Gate 2 Deterministic Acceptance Evidence

## Run identity

- Code commit: `71edc3facfc2d19fd5bb4567e34021dd3b12fd23`
- Command: `pnpm verify:ccc-prd-product`
- Pueue task: `1294`
- Started: `2026-09-01T20:06:35.260Z`
- Completed: `2026-09-01T20:10:50.293Z`
- Result: `pass`
- Canonical report SHA-256: `ffec16d922add9e53a207f83c6513429ff314a29630d9b7458f031f3ed95738c`
- Repository tree before and after: `83a7af85649788c7b1eeab3fca6675cd99bf1110`
- Repository status before and after: clean

## Deterministic check set

All 39 expected checks passed in order:

1. `built-cli-current-run`
2. `current-prd-corpus-manifest`
3. `current-prd-discovered-and-frozen`
4. `guided-operator-context-frozen`
5. `planted-defect-rejected`
6. `native-local-understanding-review`
7. `understanding-fast-lane-preserved`
8. `chunked-understanding-complete-coverage`
9. `chunked-understanding-compile-gates`
10. `native-local-authoring`
11. `semantic-v2-authority-contract`
12. `legacy-v1-readable-fresh-product-refused`
13. `frozen-packet-validated`
14. `product-owned-execution-plan`
15. `per-task-route-profiles`
16. `forged-provenance-refused-without-residue`
17. `exact-preview-confirmed`
18. `wrong-confirmation-refused-without-residue`
19. `operator-lifecycle-controls`
20. `provider-dispatch-restart-manual-required`
21. `proof-dispatch-restart-manual-required`
22. `campaign-import-admitted`
23. `import-restart-recovery`
24. `live-execution-human-hold`
25. `single-campaign-execution-authorization`
26. `task-phase-proofs-committed`
27. `coding-route-and-worktree-custody`
28. `chained-task-worktree-custody`
29. `campaign-created-commit`
30. `commit-bound-proof-executed`
31. `integrated-proof-over-two-commits`
32. `final-integrated-proof-committed`
33. `merge-human-hold`
34. `operator-readable-status`
35. `git-landing-restart-no-repeated-effect`
36. `controlled-landing`
37. `terminal-restart-recovery`
38. `fanout-campaign-import-admitted`
39. `fanout-join-execution-proved`

## Fan-out proof

The admitted lane was `TASK-FAN-A -> {TASK-FAN-B, TASK-FAN-C} -> TASK-FAN-D` with four committed provider attempts and exactly one owned mutation per task:

- A: `src/fan-a.txt`
- B: `src/fan-b.txt`
- C: `src/fan-c.txt`
- D: `src/fan-d.txt`

Observed ancestry:

- A is an ancestor of B and C.
- B and C are independent siblings; neither is an ancestor of the other.
- B and C are both ancestors of D and of D's execution-start commit.

Observed ordering:

- A task proof settled at `2026-09-01T20:09:59.668Z`.
- B and C dispatched at `2026-09-01T20:10:01.142Z` and `2026-09-01T20:10:01.088Z`.
- B and C proofs settled at `2026-09-01T20:10:22.974Z` and `2026-09-01T20:10:13.033Z`.
- D dispatched at `2026-09-01T20:10:24.989Z` and its task proof settled at `2026-09-01T20:10:37.189Z`.
- Final integrated proof dispatched at `2026-09-01T20:10:46.898Z`.

Proof custody:

- Four task proof receipts were committed, one for each task.
- Final integrated proof evidence SHA-256: `4fe10c600f5da40198ec3f3a017e0b40db01438aeeb60f8141a26788e2ee227e`.
- Final integrated terminal-envelope SHA-256: `f0d6a7667d21baf1bbf497c7ec8ef9980b52504c6ea596936275f6fd5baa16bb`.
- Final receipt-set SHA-256: `a6bc79f59b571de90a2337ec5633989802aef25499d752c5332a1cdbda8ecfa4`.
- Stop control left the work item cancelled, preserved no unresolved effects, and did not move the target main branch.

This artifact records deterministic lifecycle acceptance only. Installed real-Pi clean, recovery, and stop evidence remains separately bound to the installed-runtime receipts and must be considered with this file for the composite Gate 2 verdict.
