# CCC Multi-Task Golden Evidence

## Verdict

The hardened larger campaign is now **3/3 passing**. MiniMax, GLM, and Gemini Flash each generated the proper six-file Evidence Ledger project through three dependent tasks, produced all four green proofs, reached the durable merge-approval hold, and resolved every provider attempt to the requested peer family.

The earlier MiniMax scratch-residue failure and GLM phase-signal failure were harness interaction defects, not budget failures. The fix adds a formal signal-only Pi phase, exact admitted-root guidance, native write preflight, and before/after Git custody around every Bash call. The generous envelope remained unchanged.

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
| MiniMax hardened rerun, 1,152 cap | **Passed** | 28 / 72 / 93 = 193 | `minimax/MiniMax-M3` | All three task proofs plus integrated proof passed; no foreign candidate path survived |
| GLM hardened rerun, 1,152 cap | **Passed** | 20 / 71 / 71 = 162 | `glm/glm-5.3` | All proofs passed; the explicit signal-only reminder prevented the prior phase-handoff failure |
| Gemini Flash hardened rerun, 1,152 cap | **Passed** | 12 / 40 / 40 = 92 | `antigravity/gemini-3.7-flash-high` | All three task proofs plus integrated proof passed |

Task order is Contract / Core / CLI.

## What We Learned

- Request consumption is model- and task-dependent. On the hardened matched run, MiniMax used 193 requests, GLM used 162, and Gemini Flash used 92.
- MiniMax needed 93 requests for the CLI task alone. A six-request or similarly small common cap would have rejected useful project generation for reasons unrelated to product quality.
- GLM's prior failure disappeared after the distinct `AWAIT_PHASE_SIGNAL` handshake. The controller still requires the real `fn_complete_phase` tool; it does not infer completion from prose.
- MiniMax's prior foreign-residue failure disappeared after Bash lost its syntactic “read-only means custody-safe” exemption. Bash can still count as discovery for phase accounting, but every call receives pre/post write-set snapshots.
- Gemini Flash remained the lowest-request peer in this matrix. This is one campaign, not enough evidence for permanent provider ranking or model-specific caps.

## Harness Findings

1. `routes.json` initially rejected the new sealed `terminalRouteMembers` field even though downstream canonical/runtime layers understood it. The parser now preserves and validates the field; the built CLI was refreshed before provider work continued.
2. Failure evidence was initially too verbose for useful diagnosis. The live fixture now persists compact JSON evidence with per-task counts, bounded trace tails, proofs, and route receipts.
3. The follow-on hardening implemented a formal signal-only phase and early candidate write guard without changing tasks, caps, or routes.
4. The live fixture must use Vitest's already-isolated worker `HOME`. Creating `root/home` before lifecycle preparation violated the lifecycle helper's empty-root contract, while changing `HOME` to a non-worker path was later reversed by the subprocess-isolation guard. The fixture now prepares the lifecycle first and writes provider settings only under the current isolated worker home.
5. Combo sealing now deduplicates repeated terminal members. The sanitized snapshot has both a source-closure digest and a content digest that is recomputed on worker ingest, so changing a terminal member while leaving a stale digest is rejected.
6. If terminal status lookup itself fails while recording a campaign failure, the fixture writes a minimal receipt containing the original failure plus `evidencePersistenceFailure`; a secondary write failure is emitted without replacing the original thrown error.
7. A MiniMax failure showed that safe-looking Bash syntax cannot be trusted as custody-safe. Every Bash call now receives before/after Git write-set snapshots, while native write/edit calls also receive canonical admitted-root preflight.
8. Live failure receipts previously kept only 40 recent trace entries, which omitted the first foreign-path creation. Future receipts retain up to 200 bounded non-result trace entries per task.

## Evidence Artifacts

Raw compact receipts remain in local scratch for this run:

- `/tmp/ccc-golden-minimax-r192-20260830.json` — SHA-256 `7c2643aec6e728284051581a0e61da75d5471f6c2d9f3bf5654c3c6d00b02a29`
- `/tmp/ccc-golden-minimax-r1152-20260830.json` — SHA-256 `1d6bafcfc3f3fb42a0400adc003ebf617624529a82ddc44274f497283ed46671`
- `/tmp/ccc-golden-glm-r1152-20260830.json` — SHA-256 `59f8c1477bd2a75793b2c1f83e9cb07c4c76715312955a77375ec0c04f112421`
- `/tmp/ccc-golden-gemini-flash-r1152-20260830.json` — SHA-256 `906a3efe373eb89b0bbf5dcf57ce28ae7a7e1880f790191f8680cbe25e8862ec`
- `/tmp/ccc-golden-minimax-hardening-r2-20260830.json` — SHA-256 `be7606ab1f04193723c33b7b23bc884dc00ac6df757ceb3f8cb098e7672811ba`
- `/tmp/ccc-golden-glm-hardening-r2-20260830.json` — SHA-256 `5950a442fab459779c30c0363a4cb385db411abce1e38d45d852548322720ac9`
- `/tmp/ccc-golden-gemini-flash-hardening-r2-20260830.json` — SHA-256 `633c98c8c3498543e718472e779012f6de65092c7eaab9c86b00ff5c9e6da4de`

The receipts contain no management credential. Combo discovery occurred before worker launch; the live worker received only the sanitized sealed snapshot, which the fixture removed from its environment before Pi started.

The route-preflight digests above identify the historical live-run snapshot format. The hardened fixture now emits a new content digest plus `sourceDigest`; deterministic tamper tests cover the new format. The provider outcomes and raw receipt hashes remain historical evidence and were not rewritten.

## Readiness Classification

- Generous-limit policy: **PASS**.
- Exact three-alias active matrix with Luna removed: **PASS**.
- Alias-aware requested/effective route attribution: **PASS**.
- HOME, snapshot-integrity, failure-persistence, cross-peer-attribution, signal-only phase, and write-custody hardening: **PASS** in deterministic tests.
- Proper multi-task project generation: **PASS** in three fresh matched live cells.
- All three peer models passing the current Pi phase/custody protocol: **PASS**.

## Review And Instruction Receipts

- AGY closure review: **ACCEPT** after HOME, attribution, deduplication, digest, persistence, and CLI-boundary repairs.
- Independent code-review closure: **APPROVE**, zero remaining findings.
- Repository verification: focused core 62 tests, engine 189 tests, CLI 55 tests; all three package typechecks; scoped ESLint; `git diff --check`; and `pnpm verify:fast` 16/16 green with boot smoke.
- Hardening AGY adversarial closure: **ACCEPT** after inspecting the phase machine, executor, Pi tool wrapper, custody snapshot, live fixture, tests, and evidence claims.
- Hardening Luna closure initially returned **REQUEST_CHANGES** for a fail-open phase-entry snapshot exception. The executor now reports `CCC_CAMPAIGN_WRITE_ENVELOPE_BASELINE_UNAVAILABLE` and returns before provider dispatch; the named RED/GREEN test proves the prompt is never called.
- Hardening independent code-review closure and repair re-review: **APPROVE**, zero remaining P0-P2 findings.
- Fresh hardening verification: 248 focused engine tests, 73 affected tests, and the full 36-test executor seam green after all repairs; fake real-Postgres Evidence Ledger campaign 3/3 green; core, engine, and CLI typechecks green; production ESLint green; `git diff --check` green; and final `pnpm verify:fast` 16/16 green with build plus live `/api/health` smoke.
- The successful live matrix preceded the fail-open exception-path repair. That repair changes only the unavailable-baseline branch; the successful snapshot/fingerprint/provider path is unchanged and was re-proved by deterministic normal-path suites rather than spending three more live provider cells.
- Surface System source: `/Users/ryanpappal/01_VAULT/KnR-Vault/30_DEVSTACK/surface_system/projects/PRJ-AI-InstructionOverlay-ccc-fusion.md`.
- Staged generated proof: build `2833b03a590c8ad1` at `/Users/ryanpappal/03_CODE/surface-system/.artifacts/build/ccc-fusion-1028a6542ec4/staging/2833b03a590c8ad1`; stage audit status `pass`, exit code `0`, and the generated AGENTS/CLAUDE project-local packs contain the principle at line 50.
- Live generated-root install: **NOT PERFORMED**. The source and staged product are proven; repository `AGENTS.md`, `CLAUDE.md`, manifest, and packs remain unchanged pending the separate exact-scope install gate.
