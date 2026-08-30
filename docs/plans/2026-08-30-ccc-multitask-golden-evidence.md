# CCC Multi-Task Golden Evidence

## Verdict

The larger campaign generated a proper six-file Evidence Ledger project through three dependent tasks. Gemini Flash passed the final matched cell. MiniMax also passed one full pilot, but its final matched rerun failed custody after creating scratch residue outside the task's allowed paths. GLM generated and locally proved the Contract files but failed to emit the explicit phase-completion tool signal after its second continuation.

The enlarged limits were not the cause of either final matched failure. Request consumption is strongly model-dependent and should remain a first-class evaluation measurement.

## Final Matched Envelope

| Field | Value |
|---|---:|
| Provider tasks | 3 |
| Campaign-global requests | 1,152 |
| Campaign duration | 180 minutes |
| Concurrency | 1 |
| Context window | 200,000 |
| Maximum output tokens | 32,768 |
| Per-task token budget | 5m soft / 10m hard |

The envelope is a finite safety ceiling, not a target or reservation. It is intentionally high enough that actual model behavior determines the result.

## Route Preflight

| Alias | Sealed terminal members | Snapshot digest |
|---|---|---|
| `minimax-latest` | `minimax/MiniMax-M3` | `dc21c85538121e72bfa0f6ed4d9edd4911509dfd9b6934dd51e1ab2d7417dc9b` |
| `glm-latest` | `glm/glm-5.3`, `minimax/MiniMax-M3` | `1dc74b29202ea5c3530ea8d0385698137b4fa012c76dd62d4efb3de3efdda80e` |
| `gemini-flash-latest` | `antigravity/gemini-3.7-flash-high`, `gemini/gemini-flash-latest` | `ed1cdfbb04978879f1d4867f08455874f691dd319aa993dfff364b905649263f` |

No selected alias closure contained Luna. Every observed provider attempt resolved to the requested peer family; the GLM cell did not use its advertised MiniMax fallback. Post-run hardening now rejects any cross-peer terminal receipt as `CCC_GOLDEN_ROUTE_ATTRIBUTION_FAILED` instead of accepting every member advertised by the operational alias.

## Results

| Cell | Result | Requests by task | Effective route | Terminal finding |
|---|---|---|---|---|
| MiniMax pilot, 42 cap | Failed | Contract completed; Core began | `minimax/MiniMax-M3` | Exhausted 42/42; cap was too small |
| MiniMax pilot, 192 cap | Passed | 36 / 46 / 109 = 191 | `minimax/MiniMax-M3` | All three task proofs plus integrated proof passed |
| MiniMax final, 1,152 cap | Failed | 54 / 126 / 0 = 180 | `minimax/MiniMax-M3` | Core proof passed locally, but commit custody refused `.fusion-tmp/h2.txt` outside allowed roots |
| GLM final, 1,152 cap | Failed | 9 / 0 / 0 = 9 | `glm/glm-5.3` | Contract files and local proof passed; model omitted `fn_complete_phase` after second dirty continuation |
| Gemini Flash final, 1,152 cap | Passed | 9 / 47 / 30 = 86 | `antigravity/gemini-3.7-flash-high` | All three task proofs plus integrated proof passed |

Task order is Contract / Core / CLI.

## What We Learned

- MiniMax uses materially more Pi requests than GLM or Gemini Flash on this project. A high request count is not by itself a defect: MiniMax produced an accepted full project at 191 requests.
- MiniMax is also variable. Its final rerun spent 180 requests before a custody failure caused by repository-local scratch residue.
- GLM was fast and produced correct Contract bytes, but the Pi protocol requires an explicit phase tool signal. Text saying the work is complete is not enough.
- Gemini Flash was the cleanest final matched result: 86 requests, all proofs green, no residue or protocol failure.
- Low common caps would have hidden these differences by turning MiniMax into an artificial budget failure. Evaluation should record model/task request distributions and later tune model-specific defaults from repeated evidence.

## Harness Findings

1. `routes.json` initially rejected the new sealed `terminalRouteMembers` field even though downstream canonical/runtime layers understood it. The parser now preserves and validates the field; the built CLI was refreshed before provider work continued.
2. Failure evidence was initially too verbose for useful diagnosis. The live fixture now persists compact JSON evidence with per-task counts, bounded trace tails, proofs, and route receipts.
3. The next harness experiments should separately test an earlier out-of-scope write guard and a stronger phase-signal reminder. Those are independent from limits and should not be disguised as budget changes.
4. Independent review found that the live fixture inherited `HOME` from its test runner. The fixture now creates its own disposable home below the lifecycle root and restores the original value in `afterAll`, so it cannot overwrite operator Fusion settings even when invoked outside the usual PostgreSQL harness.
5. Combo sealing now deduplicates repeated terminal members. The sanitized snapshot has both a source-closure digest and a content digest that is recomputed on worker ingest, so changing a terminal member while leaving a stale digest is rejected.
6. If terminal status lookup itself fails while recording a campaign failure, the fixture writes a minimal receipt containing the original failure plus `evidencePersistenceFailure`; a secondary write failure is emitted without replacing the original thrown error.

## Evidence Artifacts

Raw compact receipts remain in local scratch for this run:

- `/tmp/ccc-golden-minimax-r192-20260830.json` — SHA-256 `7c2643aec6e728284051581a0e61da75d5471f6c2d9f3bf5654c3c6d00b02a29`
- `/tmp/ccc-golden-minimax-r1152-20260830.json` — SHA-256 `1d6bafcfc3f3fb42a0400adc003ebf617624529a82ddc44274f497283ed46671`
- `/tmp/ccc-golden-glm-r1152-20260830.json` — SHA-256 `59f8c1477bd2a75793b2c1f83e9cb07c4c76715312955a77375ec0c04f112421`
- `/tmp/ccc-golden-gemini-flash-r1152-20260830.json` — SHA-256 `906a3efe373eb89b0bbf5dcf57ce28ae7a7e1880f790191f8680cbe25e8862ec`

The receipts contain no management credential. Combo discovery occurred before worker launch; the live worker received only the sanitized sealed snapshot, which the fixture removed from its environment before Pi started.

The route-preflight digests above identify the historical live-run snapshot format. The hardened fixture now emits a new content digest plus `sourceDigest`; deterministic tamper tests cover the new format. The provider outcomes and raw receipt hashes remain historical evidence and were not rewritten.

## Readiness Classification

- Generous-limit policy: **PASS**.
- Exact three-alias active matrix with Luna removed: **PASS**.
- Alias-aware requested/effective route attribution: **PASS**.
- Post-run HOME, snapshot-integrity, failure-persistence, and cross-peer-attribution hardening: **PASS** in deterministic tests; not used to relabel historical live outcomes.
- Proper multi-task project generation: **PASS**, proven by MiniMax pilot and Gemini Flash final cell.
- All three peer models passing the current Pi phase/custody protocol: **FAIL**; MiniMax and GLM exposed distinct non-budget harness/model interaction failures.

## Review And Instruction Receipts

- AGY closure review: **ACCEPT** after HOME, attribution, deduplication, digest, persistence, and CLI-boundary repairs.
- Independent code-review closure: **APPROVE**, zero remaining findings.
- Repository verification: focused core 62 tests, engine 189 tests, CLI 55 tests; all three package typechecks; scoped ESLint; `git diff --check`; and `pnpm verify:fast` 16/16 green with boot smoke.
- Surface System source: `/Users/ryanpappal/01_VAULT/KnR-Vault/30_DEVSTACK/surface_system/projects/PRJ-AI-InstructionOverlay-ccc-fusion.md`.
- Staged generated proof: build `2833b03a590c8ad1` at `/Users/ryanpappal/03_CODE/surface-system/.artifacts/build/ccc-fusion-1028a6542ec4/staging/2833b03a590c8ad1`; stage audit status `pass`, exit code `0`, and the generated AGENTS/CLAUDE project-local packs contain the principle at line 50.
- Live generated-root install: **NOT PERFORMED**. The source and staged product are proven; repository `AGENTS.md`, `CLAUDE.md`, manifest, and packs remain unchanged pending the separate exact-scope install gate.
