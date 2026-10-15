# Codex handoff: ccc-fusion request-to-code PRD v3

Date: 2026-10-15. From a Claude Code orchestrator session (Opus 5.5 parent with Sonnet and Opus subagents), to a fresh Codex session.

## 1. The goal

Ryan wants ccc-fusion (his fork of Runfusion/Fusion) to take a plain-language request plus one repository and turn it into checked, runnable code.

- **Spec mode.** It keeps the request's intent, researches it, runs sealed competing designs, and writes a complete PRD and dependency plan.
- **Build mode.** It also implements, integrates and independently checks the code.

The binding product spec is `docs/plans/2026-10-13-ccc-fusion-request-to-code-prd-v3.md` (PRD v3). The implementation contract derived from it is `docs/plans/request-to-code-v3/CONTRACT-v3.5.md`, with errata E1-E17 in `docs/plans/request-to-code-v3/errata/` and four design ADRs in `adr/`.

- **Precedence:** the highest-numbered erratum wins (E17 > E16 > … > E1), then the contract, then the PRD for intent.

**The finish line that matters is increment I2.** That is one real, installed-CLI Build run (`fn plan start ... --mode build`) on an owned disposable target, with the actual three models under exact live authority.

- The models: `glm/glm-5.3`, `minimax/MiniMax-M3` and `glm/glm-5.3-flash`. GLM 5.2 is excluded; reject it and any effective-model drift.
- Contract section 4 describes the slice exactly: the target layout, commands 0-6, the per-role models and the budget arithmetic.

Everything else exists to make that run real, safe and truthful. Later increments (I3-I6), the dashboard, LEAN-v2 and ADAPTIVE-v2 come after I2.

**Ryan's preferences, binding:**

- **Functional end product over ceremony.** Be pragmatic, avoid overengineering, and don't build speculative machinery.
- **Plain-language updates.** Say what changed, what it means, and what is next. End substantive replies with Doing / Just did / Next.
- **No questions** except genuine product intent or authority he must personally give. Adjudicate everything else yourself and report after.
- **Reversible changes.** Use `.archive/` instead of deleting. Never merge `main`, release, publish, or touch production.
- **Truthful proof.** Name the command and the observed result. Evidence that was NOT RUN or BLOCKED stays incomplete; never call it done.

## 2. Hard boundaries (still in force)

- Never access `/Users/ryanpappal/03_CODE/ccc-fusion-worktrees/wave-3`. `wave-3-retry` is read-only, for dependency hydration only.
- Do not develop in the primary checkout (`/Users/ryanpappal/03_CODE/ccc-fusion`, stays on `main`). Work in `.worktrees/`.
- Do not hand-edit the generated instruction roots (`CLAUDE.md`, `AGENTS.md`, `packs/**`, `instruction-pack-manifest.json`) or the vault.
- Never expose credentials, never reauthenticate providers, and never change gateway, MCP or provider configuration. No metered compute.
- **PostgreSQL:** never use the shared `localhost:5432`, not even read-only.
  - Use only owned disposable servers. Recipe:

    ```
    /opt/homebrew/Cellar/postgresql@16/16.9/bin/initdb -D <scratch>/pgdata -A trust -U postgres --no-locale -E UTF8
    pg_ctl -D <scratch>/pgdata -l <scratch>/pg.log -o "-p <free port> -c unix_socket_directories= -c listen_addresses=127.0.0.1 -c max_connections=200" -w start
    ```

    Stop it with `pg_ctl -m fast stop`.
  - Every PG-capable test sets `FUSION_PG_TEST_URL_BASE` and `CCC_PG_URL_BASE` to your server.
  - Every non-PG vitest command sets `FUSION_PG_TEST_SKIP=1`.
  - Commands that run the proof runner (`pnpm test:ccc-planning`, `pnpm verify:ccc-planning-offline`) set neither, because the runner owns its PostgreSQL. Use `env -u FUSION_PG_TEST_URL_BASE -u FUSION_PG_TEST_SKIP`.
- Never touch port 4040 or any listener you did not start.
- The live run needs a live-authority receipt whose digest Ryan types himself (contract section 5, D23, D52).
  - Prepare the draft receipt (`$ROOT/authority/receipt.draft.json`) and show its computed digest.
  - Only a digest Ryan types in his own message goes to `--confirm-authority`.
  - Never fabricate, compute-and-supply, or confirm a receipt for him.
- Git:
  - Stage exact paths, never `--no-verify`, never force-push the default branch.
  - Pushing `agent/*` branches is fine; `agent/*` pushes trigger no CI.
  - Bare `gh` resolves to the upstream repo, so always pin `-R CrashCartCapital/ccc-fusion`.

## 3. Where things are

- **Integration branch:** `agent/request-to-code-v3`, in worktree `/Users/ryanpappal/03_CODE/ccc-fusion/.worktrees/request-to-code-v3`. It is pushed to `origin` with this handoff.
  - INT-3b (`d028d92cb`) passed the full check set:
    - four typechecks, the K1 test typecheck and lint;
    - `test:ccc-planning`: 27 commands, 1301 tests, 0 skipped, 0 failed;
    - `test:gate` on an owned PG.
  - The commits after it (INT-3c) have only **narrow** checks: core build and engine typecheck rc=0, and IM1's PG tests pass. They add IM1, the core barrel export of IM1's ops, X1z and H1. **Run the full check set first.**
- **Integrated and accepted** (each passed an independent review lane):
  - Foundations: P0, K1, K1b, S0, X1, X1b, X1c, A1, G1, K2, L1, P1, B2, B4, C6b.
  - Earlier I2 cards: AD1, B3, RP, IP, IB1, GG, CL1, P1z, L1z.
  - INT-3c: IM1, X1z, H1.
- **Proof inventory:** one module per card in `scripts/lib/ccc-planning-proof-inventory/cards/*.mjs`, auto-loaded. Each `expectedNames` list must equal the passing test names exactly.

## 4. Work in flight when the session stopped

A usage limit killed the last agents mid-run. Everything below is preserved on its own `agent/r2c-<card>` branch, pushed, with its worktree kept at `.worktrees/r2c-<card>`.

| Card | Branch state | What is left |
|---|---|---|
| C2 (tool policy and confined tools) | build, repair 1 and final repair 2 (`b6ff3320c`) all committed; repair 2 report: 44/44, P1 lane 198/198, 12 mutants killed | Its final independent review never ran. Review once, then integrate. C2 is a prerequisite for SF. |
| C5 (research fetch) | built (`f18e50a27`): 25/25, 50 of 53 mutants killed | Review never ran. Review once, then integrate. |
| LV (live and installed proof scripts) | built (`3ca0a085c`): 36/36 | Review never ran. Its correct refusal now breaks one P0 pin test in `scripts/__tests__/run-ccc-planning-proof.test.mjs` ("makes the live and installed commands exit 1 with a NOT_IMPLEMENTED refusal..."). Update that pin at integration. LV added the flags `--project` and `--database-url`. |
| GGz (G4 importer/custody parity) | build plus repair 1 committed; `8822cba14` is an UNVERIFIED WIP of repair 2 (errata E16) | Finish the E16 items (lone-surrogate paths, compiler `file:` parity, entity-id pins, comment fixes), test, review once, integrate. GGz must land before IB2. |
| BF (linked writer caps, campaign outcome) | `17ef554a2`: UNVERIFIED WIP (hook hunks plus new files) | Finish it per the BF card plus E8-0, E10 and E14. Core card, real PG, the riskiest remaining core work. |
| AU4 (disposable target) | `b768b195e`: UNVERIFIED WIP | Finish, test, review. |
| AU2 (live-execution release) | `f9e790716`: UNVERIFIED WIP (24-line source stub only) | Mostly not started. Build per the AU2 card and section 2.18. |
| H1z (host race and residuals) | errata E17 written; the worktree was removed with nothing in it | Recreate it from the integration tip and build per E17. Item 1 is a real race: an operator resume or answer that lands between the host's park and its held write strands the run. The adversary's reproductions are summarised in E17. |

The WIP commits are partial output from killed agents. Treat them as drafts: read, finish, and prove them before trusting any line.

## 5. Not started (contract order)

- **SF**, the real session factory. Needs C2, H1 and X1z; H1 and X1z are integrated, so it needs C2 integrated.
- **C6**, degenerate output, the tool-fidelity preflight and the pin check. Needs SF.
- **VP**, verifier preparation, the G5 oracle gate, spec-ready and the Build baseline. Needs AU4 and others.
- **RV**, the G7/G8 review port. Needs SF and BF.
- **CB**, the Build control bridge. Needs BF and H1.
- **ST1 and ST2**, the planning stages.
- **IB2**, the import bridge. It carries obligations from E13, E15 and E10 N-5, listed in `run-state-2026-10-15.json` under `obligations_ib2`.
- **CL2**, `fn plan start` and G0.
- **WR**, the runtime wiring and writer sessions.
- **O1**, the offline end-to-end exit gate for I1.
- **O2**, the offline Build slice and Spec mode.
- **LIVE**, the I2 run in contract section 4.

The dependency lists for each are in CONTRACT-v3.5 section 3.

## 6. Recommended path (pragmatic, no overengineering)

The previous orchestration was thorough but slow. Every card got builders, critical reviewers, adversaries, mutant sweeps, and z-card re-plans for non-blocking parity gaps, and that process consumed most of the budget. The PRD's real milestone, the I2 live run, has not happened yet. Change the cadence:

1. **Stabilise.** Run the full check set on the integration tip and push.
   - `pnpm --filter @fusion/core build && pnpm --filter @fusion/engine build`
   - The four typechecks: core, engine, cli, dashboard.
   - `pnpm lint`
   - `env -u FUSION_PG_TEST_URL_BASE -u FUSION_PG_TEST_SKIP PI_OFFLINE=1 pnpm test:ccc-planning`
   - `pnpm test:gate` with an owned PG.
2. **Land what is done.**
   - Review and integrate C2, C5 and LV, one reviewer each. Fix the P0 pin for LV.
   - Finish GGz, BF, AU4 and AU2 from their WIP.
   - Build H1z, item 1 at least. Items 2-5 are hardening; do them only if cheap.
3. **Build the path to the live run in dependency order:** SF → C6 → VP → RV/CB → ST1/ST2 → IB2 → CL2 → WR → O1/O2. Keep each card minimal against its contract block.
4. **Review rule.**
   - One independent reviewer for normal cards.
   - Reviewer plus adversary only for authority, custody, cancellation or money paths: BF, AU2, CL2, WR, IB2.
   - Do not open re-plan cards for fail-closed or non-blocking gaps. Record them as follow-ups and move on.
5. **Run the I2 slice** (contract section 4.2) as soon as the path is wired.
   - Prepare the target and the receipt draft, then ask Ryan once for the typed digest.
   - Run the live slice under exact authority.
   - Record actual vs synthetic proof honestly.
6. **Then the final deep `task verify`, the installed-acceptance walk-through, and the closeout.** The closeout covers:
   - launch and use instructions;
   - the candidate path and version;
   - per-requirement evidence;
   - gaps;
   - rollback and resume.

## 7. Known issues and follow-ups

- **Pre-existing on `main`, load only:** `ccc-campaign-execution-authorization.pg.test.ts` "RED-S3-opened-lifecycles" sits at the 15 s vitest default and times out at load ≥ ~12. Our branch is not slower (timed side by side). It is in the frozen `run-ccc-pg-proof.mjs` mapping, so it was not quarantined; the fix is to split it per lifecycle.
- **Possible real defect in the protected safety lane:** `run-verification-command.test.ts`, "aborts a spawned verifier process group before its hard timeout", failed once under gate load (10016 ms vs 10000 ms). Not quarantined.
- **For Ryan:** an early agent left test databases on the shared `:5432`. They are named `fusion_test_18636_*` and were never touched again. Ryan should know about them.
- **L1** `STATE_CODE_REQUIRED` omits `awaiting_intent`. This is defence in depth, for the next core planning card.
- **X1 discovery test:** pin the optional-loop directories as well.
- **VP:** closure directories that differ only in case are admitted under a plumbing-built B1.
- **ci-linux:** the GGz NFD non-Darwin custody branch has never run on Linux.
- **H1 residuals (E17 "Recorded"):**
  - the drain query has no LIMIT;
  - no retryAfter backoff on release;
  - the runtime digest is computed at `start()`;
  - recovery runs only when `engineInstanceId` is set.
- **I2 declared NOT RUN:**
  - extraction leaves;
  - coding repair;
  - G9 delivery;
  - live Spec mode;
  - ADAPTIVE/LEAN;
  - the macOS CI lane.

  `fn plan pause|resume` during building and importing is refused in I2 and is an I4 item.
- **Required commands:**
  - `pnpm test:ccc-planning` and `pnpm verify:ccc-planning-offline` exist.
  - `pnpm verify:ccc-planning-live --profile full|adaptive|lean --candidate PATH --approval-receipt PATH --confirm-authority <digest>` and `pnpm verify:ccc-planning-installed --candidate PATH --approval-receipt PATH` exist as package keys. On the integration branch their scripts are still P0's NOT_IMPLEMENTED stubs. LV's real scripts replace them.
  - In I2 only `--profile full` is accepted.

## 8. Practical traps (learned the hard way)

- CLI and dashboard typechecks read the engine `dist`, so build the engine first. The engine and core tsconfigs exclude `__tests__`, so type-check test files with a scratch tsconfig.
- Engine vitest runs must pin `--project=engine-default`. The `engine-core` project runs a build in its global setup.
- Real-pg harnesses **skip silently** without `CCC_PG_URL_BASE`. A skipped count above 0 is a failure.
- `check-no-kill-4040` flags any file that mentions 4040. A file-level `port-4040-allowlist:` comment allowlists a refusal-only mention.
- The host load is often 10-17 when several agents run. Never widen a test timeout to hide slowness: report it, or fix the test.
- The `/usr/local/bin/rm` guard silently drops `rm -rf` without a TTY. Use `.archive/` moves or `git worktree remove`.
- `serve` runs the engine in-process. A rebuild is inert until serve restarts, and serve refuses a run whose runtime digest differs (contract section 6 risk 32).

## 9. Evidence and state files

- `docs/plans/request-to-code-v3/run-state-2026-10-15.json`: the orchestrator's last checkpoint, with verdicts per card, follow-ups and IB2 obligations.
- Review evidence (scratch copies, mutant logs) lived in a session temp scratchpad that may not survive. The errata summarise every adopted finding, so treat the errata as the record.
