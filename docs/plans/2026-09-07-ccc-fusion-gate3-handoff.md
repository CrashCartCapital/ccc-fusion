# CCC-Fusion Gate 3 Handoff — 2026-09-07

## Where we are

The goal right now, called Gate 3, is to prove that Ryan can hand the system one of his own real feature write-ups, watch it get built automatically by AI workers, understand what happened, and see the finished code land as a pull request, all without needing to read a plan document or the underlying code himself.

The code repo's main branch sits at commit `b845a722a`, which carries pull requests #72 through #76, all merged and green. The "referee" — the component that judges whether a piece of AI-generated proof evidence is real and complete — is pinned to a specific verified version, commit `3a4dbeb` in its own separate repository, so it will not drift while the rest of the system changes underneath it. The live engine (the running server that manages an in-progress work campaign) was relaunched under Pueue (a background job runner that keeps a process alive even if the terminal session that started it goes away), in a job group named `ccc-fusion-l12`, after an incident where an unrelated self-healing process accidentally deleted a working folder mid-run. As of the last entry in the source ledger, round 10 of the live campaign was mid-recovery from that incident: the fix (removing a project that had registered itself by mistake, relaunching the engine with the correct working directory, and confirming the working folder survives several cleanup cycles before resuming) had been ordered but not yet confirmed complete.

## Open PRs

- **#77 (commit-owned fix)** — reviewed and accepted, the two minor issues from review have been fixed, now awaiting CI and merge.
- **#78 (sweep guard fix)** — the first version was reviewed and rejected as unsafe; a redesign is planned but still in draft, not yet coded.

## Halts so far

Twelve halts total, each one the system correctly refusing to proceed on a real problem rather than a false alarm:

1. First real campaign halted at dispatch on a real defect; two fix lanes launched and worker policy corrected.
2. Second real campaign dispatched and a worker wrote real code, then halted on the write envelope (the wrapper around a worker's submitted change).
3. Round 2 dispatch halted on a branch-name collision; a product fix lane was launched.
4. Round 3 produced the first real campaign commit, then halted at proof admission on a definition-hash mismatch (the ledger's halt counter reached five during this investigation).
5. Round 4 halted at proof materialization on a Mach-O headerpad problem (a low-level Mac binary-format issue).
6. Round 5 halted at proof pre-dispatch custody, the ledger's halt eight; PR #68 landed to fix it.
7. Round 6 halted again at proof pre-dispatch custody, halt nine: a sealed copy of Homebrew's Node.js failed its own version check.
8. Halt nine was root-caused to a timeout during cold code-signature validation under load, and fixed via PR #72.
9. Round 7 executed the first real proof ever, then halted at halt ten when a verifier that actually passed was wrongly refused as "not canonical JSON."
10. Halt ten was adjudicated as the project's own referee violating Fusion's proof-evidence contract; three fix lanes were dispatched.
11. Round 8 halted at halt eleven: the referee refused inside a worker's own internal verify step, because required environment variables that only exist in the official proof run were missing there by design.
12. Round 9 halted at halt twelve, at preview time before any campaign was even created: the verifier's dry-run check refused because its temporary test folder had no source directory; this was later diagnosed as a fidelity gap in that dry-run check and fixed via PR #76.

## Next steps

1. Merge PR #77 once its CI run comes back green.
2. Redesign and rebuild PR #78's sweep guard using the safer, marker-file-based ownership design that was agreed after the rejected first attempt.
3. Upgrade the live engine to the latest merged code between campaign rounds, never in the middle of one.
4. Push round 10 (and round 11 if needed) through to the campaign's first completed proof.
5. Land the finished work on the `agent/qe-evidence-envelope` branch.

## Operator-only items

- A list of old, safe-to-drop stashed changes is waiting for Ryan's review at `.archive/l30-primary-checkout/05-operator-stash-drop.md`. This is not something an agent should act on unattended.
- Recycling the CI runner's build containers periodically (to stop disk usage from creeping back up) has been identified as a real fix but is deliberately deferred, not scheduled yet.

## Do not

- Never launch the live engine (`serve`) without first changing into the target repo's own directory. Launching it from the wrong directory is what caused the working-folder-deletion incident above.
- Never background the engine with a tool's own background-process flag.
- Always launch and keep the engine running through Pueue instead, so it survives a session restart.
