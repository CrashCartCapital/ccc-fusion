# CONTRACT errata E6: W1-residual verdicts, X1c and X1b repair 1, the v3.2 check, and the toolchain decision

Date: 2026-10-14. Binding on top of CONTRACT-v3.2 (frozen; it folds v3.1, E3 and E4). Order of precedence: E6, then E5, then v3.2.

## Verdicts (W1 residual, round 1)

- **K1b at a46fed5e1: ACCEPTED** (critical lane; both the Opus review and the Opus adversary accepted). Cherry-picked onto integration as INT-2b `ee89957c1`. Recorded residuals:
  - A control path that is a parent directory of a verifier bundle file, or a new file inside a bundle directory, is not refused. This fails closed in practice, because the control's failure carries no `[REQ-x]` tag.
  - The test comment that says ẞ and ß are written "as escapes" is false (cosmetic).
- **X1c at 6782c1004: REPAIR.** One fail-open path, plus hardening the adversary recommended. Repair 1 of 2.
- **X1b at 8025e5a87: REPAIR.** Two tests cannot fail, some hardening is untested, and the default search path reaches into user-writable directories. Repair 1 of 2.
- **CONTRACT-v3.2: FROZEN.** Twelve non-blocking findings (F1-F12) are ruled on below. A v3.3 editor applies E5, E6 and these rulings.

## E6-0 Leader decisions

- **Toolchain required set (the I2 host lacks Homebrew grep, findutils, gawk, diffutils and dash).**
  - The host is not changed. No `brew install`.
  - `discoverCccToolchain`'s default `required` set is the minimal set every Fusion command needs: `bash`, `sh`, `node`, `git`, `task`, `rg`, and the GNU coreutils.
  - GNU grep, sed, findutils, gawk and diffutils become an **optional** set: each is sealed under its unprefixed name when it is found, and silently left out when it is not.
  - `discoverCccToolchain` gains `optional?: readonly string[]` (default: that optional set).
  - The qualification receipt and the planning prompts can name the missing optional tools. A later card that needs them asks the operator, once, to install them.
- **Default search path.** It is Homebrew only: `/opt/homebrew/bin`, then the `opt/<formula>/bin` and `libexec/gnubin` directories of the formulae the catalogue names. User-writable directories (`~/.local/bin`, `~/go/bin`, `~/.cargo/bin` and the like) are never on the default path. A caller may still pass an explicit `searchPath`. `whoami` leaves the catalogue, because it fails inside the sandbox.
- **Package commands in Taskfiles.** go-task runs `cmds` in its own shell, so the `BASH_ENV` dispatcher and `command_not_found_handle` never apply there, and neither does bash's `exec` builtin. This is recorded as an I3 prerequisite: verifier Taskfiles that run package scripts wrap them in `bash -c`, and VP or GG enforce that. I2 is unaffected, because its target runs `node --test` directly.
- **First-launch cost of cloned binaries.** A clone pays macOS's first-launch check (about 0.5-1.4 s per binary). This is a risk row: SF and WR measure it before trusting short model timeouts. It is not a repair item.
- **RV (F12).** RV's RED uses `new PermanentError(<message>, "CCC_PLANNING_REVIEW_REJECTED")` and asserts `blockedReason === "ccc-permanent:CCC_PLANNING_REVIEW_REJECTED"`, as E4-4 does for WR.
- **CccConfinement dispose type (v3.2 open item).** P1's repair (E5-P1, new item 12) types `CccConfinement.bash` structurally as `(BashOperations & { dispose(): Promise<Readonly<{ closure: "confirmed" | "unconfirmed" }>> }) | null` in `agent-runtime.ts`. It needs no X1c import, because P1's base has no X1c bytes. The structure equals X1c's `CccConfinedDisposeResult`.
- **W1r integration.** K1b is at INT-2b. X1c and X1b land at the first INT step after each is accepted, and both before W4.

## E6-X: card X1c repair 1 (opus, critical)

Base: rebased onto INT-2b `ee89957c1`. Owns: as E4-X.

1. **The fail-open path (required by the review).**
   - Make the orphan kill best effort, so it can never replace the closure error. Wrap `killReaperStoppedPids(...)` in try/catch, record the failure in the error message, and always `throw new CccConfinementClosureError(...)` when `!sweep.converged` or when the reaper frame is unsandboxed.
   - Set the instance's unconfirmed latch directly at that point in `execOnce`, not from the error class in `operations.exec`.
   - Proof: the review's fault-simulation mutant, a ps capture that throws `spawn ENOMEM` synchronously. The exec must still reject with `CccConfinementClosureError`, and `dispose()` must return `unconfirmed`. The frozen seam cannot reach `/bin/ps`, so give the evidence as a reported mutant run.
2. **Dispose evidence.** `dispose()` returns `unconfirmed` when its final sweep found and killed any instance process, because a survivor proves an earlier confirmation was wrong. It also does so in the cases E4-9 already names. RED: a background escaper that survives an exec, then `dispose()`.
3. **Stopped-orphan filter (v3.2 F3).** On the unconfirmed path, kill a reaper-reported pid only if all of these hold:
   - it has the same uid;
   - it is stopped;
   - its start time (`ps -o lstart=`) is no earlier than this exec's start;
   - its executable path lies in the instance clone directory, where you can read that path in a way `exec -a` cannot spoof.

   If macOS gives no such executable path without lsof, use the first three conditions, say so, and add a test that an older stopped same-uid process the test owns (stopped before the exec started) is not killed.
4. **`killStoppedSeen` test.** Use a stateful lsof stub, which the frozen `lsofPath` seam allows: its first scan lists the controller and an instance pid, and later scans fail. Assert that the pid it had stopped is killed. A mutant removing `killStoppedSeen` must fail it.
5. **lsof stalls (the root cause found by the X1b adversary).** Bursts of `lsof` scans hit the 11 s capture limit while an unreachable smbfs Time Machine mount (`/Volumes/.timemachine/…`) is present on this host.
   - Evaluate, with measurements: lsof `-b`, which avoids blocking kernel calls; `-e <mount>` for each network mount, read from `mount` (smbfs, nfs, afpfs, webdav); and one bounded retry of a timed-out scan.
   - Apply what removes the stall without weakening the E4-7 trust rule. The scan must still parse, still list the controller's own pid, and still see clone inodes; a test proves that with the chosen flags.
   - Record the evidence (stall rate before and after, flags chosen) in the card header and as a §6 risk row. Do not unmount or change the host.
6. **One path key.** Replace `confined-shell.ts`'s private copy of the E2-40 fold (about line 843) with K1's `cccPlanningPathComparisonKey` from `@fusion/core`. INT-2b carries the K1b form that closes U+1E9E. RED: a caller-added denied name `.ssh` refuses a write to a not-yet-existing `.ẞh` path.
7. **Template material covers the dylib-closure discovery.** Either bring the rules of `darwinLinkedRuntimeFiles`, `resolveLinkedPath` and the read-root derivation into `CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL`, or show that the qualification receipt records the digest of the fully rendered profile, including the discovered read roots, so that a widened read root changes a recorded digest. A test either way. `ccc-campaign-proof-sandbox.ts` is X1-owned, and the grant is helper exports only, with no behaviour change.
8. **Record the measurement.** Put the adversary's high-load measurement in the `cards/x1.mjs` header: 51/51 in 125 s at load 24.6-36.2 (mean 33), lsof at most 0.51 s, using 20 bounded CPU burners. Keep `timeoutMs` at least 1.5 × the worst duration measured.
9. **Optional.** Drop EACCES from the optional node-overwrite regex, so that it discriminates.

## E6-B: card X1b repair 1 (opus, critical)

Base: the X1c round-1 head `6782c1004`. The branch is rebased onto it, so X1b sees `CccSealedToolchain.libraries`. When integrating, the parent cherry-picks only X1b's own commits. Owns: as E4-B.

1. **Pin the shim interpreter.** `PNPM_SHIM`, or a dedicated `#!/bin/sh` fixture, prints `SH-BASH=${BASH-unset}` and whether `SHELLOPTS` contains `posix`. Assert:
   - when `sh` was sealed from bash: `SH-BASH` equals `join(dirname(exec), "sh")` with posix on;
   - when it was sealed from dash: `SH-BASH=unset`.

   Mutant `sh|dash) tool=bash` must fail. Keep the raw-shell control.
2. **Pin directory-first lookup.** Add an unprefixed `cat` stub in a directory after `earlier/`, and keep asserting that `cat` resolves to `{path: earlier/gcat, name: "cat"}`. Mutant D12 (loops swapped) must fail.
3. **Untested hardening becomes tested or goes away.**
   - An extra file in the wrappers directory refuses the next exec. Implement this, since the header claims it: plant `<install.dir>/extra-planted`, and the exec is refused.
   - The `env -S` shebang handling has a test.
   - A missing `bash` role and a missing `node` role each refuse with `toolchain-missing:<tool>`.
   - The X_OK check in `usableCandidate` has a test.
4. **E6-0 decisions.**
   - Default `required` is the minimal set, plus the new `optional` parameter. Optional tools are sealed when found and absent otherwise.
   - The default search path is Homebrew only, with `whoami` dropped.
   - REDs, all from fixture PATH directories with stub executables:
     - a missing optional tool still yields a toolchain;
     - a missing required tool refuses;
     - a tool found only in a user-writable directory is not found by default, but is found when the caller passes that directory explicitly.
   - Positive control on this host: the default discovery succeeds.
5. **Sizing.** Measure the closed check once at host load average 25 or more. If the host is quieter, add bounded CPU burners for at most 3 minutes and stop them afterwards. Set `timeoutMs` to at least 1.5 × the worst run, and record both runs in the header.
6. **Record, do not fix:**
   - `cccConfinedShellLastClosure` must be read from the inner operations; WR does this.
   - The Taskfile, `exec` and PATH-change residuals.
   - pnpm and yarn have no wrapper.
7. **Contract text (no code):** `sh` is passed as `sealCccToolchain`'s `sh` path, which always appears in PATH as `sh`, so no name field is passed (v3.2 F4).

## E6-C: rulings on the v3.2 check findings

These are text-only edits for the v3.3 editor:
- **F1:** apply the check's wording.
- **F2:** REDs (9) and (10) are pinning tests whose failing signature comes from a reported mutant.
- **F3:** apply as E6-X item 3.
- **F4:** apply as E6-B item 7.
- **F5:** shell-compat exports a BashOperations decorator that prefixes each command with the dispatcher setup; SF and WR apply it.
- **F6:** add exception (iii): `CccSealedToolchain` may gain output fields that only `sealCccToolchain` computes.
- **F7:** restore "the current integration head (INT-1b or later)".
- **F8:** replace with "INT-1 is a426a4377 (core and schema barrels)".
- **F9:** write the set, in code order.
- **F10:** "Accepted residual (E4 S0 verdict)".
- **F11:** add K1b to GG's Depends.
- **F12:** as E6-0.
