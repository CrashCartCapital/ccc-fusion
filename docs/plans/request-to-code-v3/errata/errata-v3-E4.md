# CONTRACT-v3.1 errata E4: final-repair verdicts, the v3.1 check, and the K1b, X1c and X1b cards

Date: 2026-10-14. Binding on top of CONTRACT-v3.1 (which already folds v3, E1 and E2). Order of precedence: E4, then E3, then v3.1. Where E3 and v3.1 differ, E3 wins (v3.1 was compiled before E3 was read).

## Verdicts on the W1 final repairs (round 3)

- **K1 at 0026543d1: ACCEPTED with one residual defect, routed to K1b.** Both reviewers independently found that the E2-40 key formula misses U+1E9E (capital sharp s). `ẞ`, `ß` and `ss` open the same APFS file, but `ẞ` keys to `ß` while the others key to `ss`. This is the errata formula's fault, not the repairer's. The K1 lineage has no repairs left.
- **S0 at 7d8e2118d: ACCEPTED.** Both reviewers say ACCEPT. Recorded residuals:
  - The deadline CHECK tests only the text's shape, so an impossible date fails later as an untyped 22008, closed.
  - The Drizzle mirror of the deadline CHECK has no test.
  - The 0043 guard casts `lease_expires_at` without a format check.
- **X1 at 63a5c05f0: ACCEPTED for production behaviour, with test and hardening residuals routed to X1c.** Every production E2 item survived mutation. The defects:
  - the E2-24 layout test can never fail;
  - the closed check runs 153-261 s against a 180 s runner bound;
  - the 1 s quick control still flakes at load average about 30.
  - Hardening gaps (E4-X below) are also routed to X1c.
- The three commits are cherry-picked onto `agent/request-to-code-v3` as 9a8054a0a, 596a5d7bf and ff4fc3e4f (INT-1b). Core typecheck, core build, engine typecheck, CLI typecheck, the K1 test-tsc check and lint all exit 0.

## E4-1 v3.1 check findings (the leader's rulings)

- **E4-1 (F1).** Apply E3-1 to E3-4 as written:
  - drop `ROLE_CLASS_MISMATCH` and `CONTROL_STATE_INVALID` from the §2.3 union;
  - E2-3 uses `STATE_TRANSITION_REFUSED`;
  - E2-9 uses `ROUTE_NOT_ADMITTED` with detail `role-class-mismatch`;
  - L1's actor over 200 characters uses `INTERNAL_ERROR`;
  - `WRITER_CLOSURE_UNCONFIRMED` comes from card K1b, and WR and BF depend on K1b.
- **E4-2 (F2).** E2-5's run state is **`blocked_prerequisite`**, through the existing pair `building → blocked_prerequisite`. In the §2.3 state-to-code table, `CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED` sits under `blocked_prerequisite`. The BF row and RED read `building → blocked_prerequisite`. The open item is closed.
- **E4-3 (F3).** WR rule:
  - wrap `cccConfinement.bash` at the writer call site, so that the first `CccConfinementClosureError` thrown from `exec` is latched;
  - then abort the session and, once it settles, rethrow at the call site;
  - then quarantine as E2-5 says.

  WR's RED drives a stub `BashOperations` whose `exec` throws `CccConfinementClosureError` through the real Pi session and tool loop, with no call-site injection. Pi's agent loop turns tool errors into error tool results (`pi-agent-core dist/agent-loop.js:468-475`), which is why the latch is needed.
- **E4-4 (F4).** WR raises `new PermanentError(<message>, "CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED")`; the second argument is the code (`engine-errors.ts:147`). WR's RED asserts `blockedReason === "ccc-permanent:CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED"` and a manual-required item.
- **E4-5 (F5).** X1b:
  - Discovery refuses a missing required tool by throwing `CccPlanningRefusal` with code `CCC_PLANNING_CONFINEMENT_UNQUALIFIED`, detail `toolchain-missing:<tool>`. X1b's RED asserts that refusal on a fixture PATH; it does not touch G0.
  - Add X1b to CL2's Depends.
  - G0 step 11 becomes "discover and seal the toolchain (X1b `discoverCccToolchain`), then `qualifyCccConfinedShell`". CL2's single-fault RED gains the missing-tool case.
  - SF and WR take their toolchain from the same discovery, and SF and WR depend on X1b.
- **E4-6 (F6).** Named REDs:
  - **CB:** `applyCccPlanningBuildControl` with a 2,000-character actor returns `{kind:"refused", code:"CCC_PLANNING_INTERNAL_ERROR"}` and changes no row. With a 200-character actor, the control event's `agentId` is `operator:<actor>`.
  - **CL1:** a 2,000-character actor, or one that is blank after trimming, exits 2 with `usage_error`, and deps are never called. A 200-character actor is passed to deps unchanged (spy).
  - **L1:** its RED names `CCC_PLANNING_INTERNAL_ERROR`.
- **E4-7 (N1).** The exit status of the lsof sweep never decides the outcome. A sweep is trusted only if its output parses and lists the controller's own pid. Any other result, including exit 1 with empty stdout, means `closure-sweep-unavailable` or unconfirmed. X1c pins this with a test.
- **E4-8 (N2).** The literal X1 default list in §2.13 is `.env`, `.env.*`, `.envrc`, `.agentsecrets`, `_secrets`, `.npmrc`. X1's final repair already added `.envrc`. The E2-81 consistency test is X1c's new `packages/engine/src/__tests__/ccc-confined-denied-names.test.ts`, listed in `cards/x1c.mjs`.
- **E4-9 (N3).** `CccConfinement.bash` is typed `(BashOperations & { dispose(): Promise<CccConfinedDisposeResult> }) | null`, where `CccConfinedDisposeResult = Readonly<{ closure: "confirmed" | "unconfirmed" }>`. Owners:
  - SF disposes planning sessions at session end and records an `unconfirmed` closure as an attempt fact.
  - WR disposes writer sessions, and an `unconfirmed` closure quarantines exactly as E2-5 does.

  SF and WR each get one RED for this.
- **E4-10 (N4).** C2's grep path filter calls `cccConfinedWriteRefusal` with `writeRoots: readRoots`, so only the `.git` and denied-name checks apply. C2 validates its denied names against `[A-Za-z0-9._*-]` before calling, because the predicate throws a plain `Error` on an invalid name.
- **E4-11 (N5).** A role is reviewer-class when `roleClass === "critic"`. It is author-class otherwise (`author`, `researcher` or `writer`), per D13 and the K1 `CccPlanningRoleClass` union.
- **E4-12 (N6).** The S0 contract text is corrected to match the accepted tests:
  - the explicit project change is a second refused case;
  - the succeeding control updates a mutable column, or sets `project_id` to its own value;
  - the NULL case runs in a bypass session with no project GUC.

  No code changes.
- **E4-13 (N7).** Build cancel is accepted from every linked state that has a `→ cancelling` pair in the §2.2 function: `importing`, `awaiting_execution_authority`, `building`, `paused`, `awaiting_budget`, `blocked_prerequisite`, `blocked_provider`, `budget_exhausted`, `unknown_effect`, `verification_failed` and `accepted`.
  - `delivering` is refused with `STATE_TRANSITION_REFUSED`.
  - Terminal states keep `RUN_ENDED` and `RUN_TERMINAL`.
  - D32 is updated to match.
- **E4-14 (N8).** K1 RED wording: values that are zero, negative, or floor below the requirement return a time shortfall and never throw. A sufficient fractional value is admitted.
- **E4-15 (N9).**
  - X1b's discovery REDs use fixture PATH directories with stub executables, and the real host scan is reported as evidence only.
  - `sh` is sealed from a named source with `name: "sh"`: Homebrew `dash` if present, else Homebrew `bash`.
  - The positive control, the real host scan, stays Darwin-only.
- **E4-16 (N10).** In the Appendix, X1b owns four new files plus `cards/x1b.mjs`.

## E4-K: card K1b (expanded; W1 residual, starts now)

- **Base:** INT-1b `ff4fc3e4f`.
- **Route:** sonnet build. **Review:** critical, because path ownership is a safety invariant.
- **Depends:** K1.
- **Owns:**
  - `packages/core/src/ccc-planning/errors.ts` (append only);
  - `packages/core/src/ccc-planning/schemas.ts`;
  - `packages/core/src/__tests__/ccc-planning-{schemas,policy,artifacts}.test.ts`;
  - whichever K1 test pins the refusal-code list;
  - `scripts/lib/ccc-planning-proof-inventory/cards/k1.mjs` (successor owner).

**K1b items:**

1. **Refusal code.** Append `CCC_PLANNING_WRITER_CLOSURE_UNCONFIRMED` at the end of `CCC_PLANNING_REFUSAL_CODES`, and update the test that pins the list or count. RED: the pinned-list test fails before the change. Control: every existing code keeps its position.
2. **E2-40a key.** The key is `posix.normalize(p.normalize("NFC").toLowerCase().toUpperCase().toLowerCase().normalize("NFC"))`, with trailing slashes trimmed as now. Use ASCII test names, for example "capital sharp s". REDs:
   - `src/ẞ.mjs` against `src/ss.mjs`, and `src/ẞ.mjs` against `src/ß.mjs`, across two tasks;
   - `src/straẞe.mjs` and `src/strasse.mjs` as duplicates within one task;
   - bundle files `test/straẞe.mjs` and `test/strasse.mjs`;
   - key equality for ẞ, ß and ss;
   - `key(key(x)) === key(x)` over a fixed sample that includes ẞ.

   Controls: `ß` against `ss` stays refused, and I against dotless ı stays the accepted, pinned over-refusal.
3. **Freeze test strength.** In a fresh module import (`vi.resetModules()` then dynamic import inside the test), assert that every module-level constant feeding the policy digest is deep-frozen *before* any digest call. RED: the test must fail if any one module-level `deepFreezeCccPlanningConstant` call is removed. Report each mutant.
4. **Controls cannot replace the verifier.** `validateCccPlanningVerifierBundleV1` refuses a control file whose comparison key equals a verifier bundle file's key, or lies inside it. Control: a control that replaces an implementation file outside the bundle is admitted.
5. **Defence in depth.**
   - Spec-ready `verifierBaseline.files` go through the E2-41 helper: key de-duplication plus refusal of `.git`, `.env` and denied names.
   - Requirement-map `proofIds` must match `CCC_PLANNING_PROOF_ID_PATTERN`.
   - RED and control for each.
6. **Accepted residual, not a RED.** Denied names match whole segments only, so `.envrc.bak` is admitted.

## E4-X: card X1c (X1 residual; W1 residual, starts now)

- **Base:** INT-1b `ff4fc3e4f`.
- **Route:** opus. **Review:** critical.
- **Depends:** X1.
- **Owns:**
  - `packages/engine/src/ccc-confinement/confined-shell.ts`;
  - `packages/engine/src/__tests__/ccc-confined-shell.darwin.test.ts`;
  - `scripts/lib/ccc-planning-proof-inventory/cards/x1.mjs` (successor owner);
  - new `packages/engine/src/__tests__/ccc-confined-denied-names.test.ts`;
  - new `scripts/lib/ccc-planning-proof-inventory/cards/x1c.mjs`.

**X1c items:**

1. **E2-24 layout test.** Rewrite it with builtins and node only:
   - `n="$(command -v node)"; echo planted > "${n%/*}/planted"; echo "bin-write-rc=$?"`;
   - a node `mkdirSync($HOME/../toolchains/other)` that prints `toolchains-mkdir-err <code>`;
   - optionally, a node `writeFileSync` over `${n%/*}/node`.

   Assert `toMatch(/^bin-write-rc=1$/mu)` and `toContain("toolchains-mkdir-err EPERM")`, never a bare `rc=1` substring. Keep the existsSync checks and the `$HOME` write as the positive control. Non-vacuous: removing the toolchains write-deny makes the test fail (report the mutant).
2. **Load-independent quick control.**
   - The quick positive control uses a model timeout of at least 30 s.
   - Only the command that must time out keeps the 1 s timeout.
   - The wall timer starts at the reaper's CCC-STARTED frame, so per-instance clone and hash time is never counted; bash and node start-up inside the sandbox is counted, as Pi's native bash counts it.
3. **Runtime inside the bound.**
   - Share one operations instance, and one qualification, across tests that do not test isolation, lifecycle or qualification itself.
   - Replace any second full qualification that E2-21 does not need with the narrowest probe.
   - If needed, split `cards/x1.mjs` into several names-closed commands.
   - Set each command's `timeoutMs` to at least 1.5 × the worst duration measured at host load average 25 or more, and within P0's maximum.
   - Run the closed check twice and record both durations and load averages in the card header. This sizes a runner hang bound for a deterministic suite; it is not a test-timeout widening.
4. **Seal coverage.**
   - The toolchain digest, the post-clone hash check and the per-exec drift check cover every file `cloneToolchain` copies, including `lib/*.dylib` such as `libnode`, not only PATH-named executables.
   - A per-exec check may use size, mtime and inode, provided the full hash runs at seal time and after the clone.
   - RED: a fixture toolchain whose cloned library changes after sealing is refused with `toolchain-digest-drift`. Control: unchanged runs.
   - `CccSealedToolchain` gains fields only if `sealCccToolchain` computes them, because callers never build it by hand.
5. **Narrow the production seam.**
   - `createCccConfinedBashOperations(input, testOnly?)` accepts only `{ lsofPath? }`. Any other key, `sealedEnvironment` included, throws `TypeError`, and a RED covers it.
   - The environment seam stays only on `qualifyCccConfinedShell` (E2-11).
6. **Dispose result.**
   - `dispose()` returns `CccConfinedDisposeResult` (E4-9).
   - It returns `unconfirmed` when its final sweep does not converge, or when any earlier exec ended `CLOSURE_UNCONFIRMED`.
   - It is idempotent.
   - RED: a failing lsof stub gives `unconfirmed`. Control: real lsof gives `confirmed`.
7. **Template material.**
   - `CCC_WRITER_SHELL_PROFILE_TEMPLATE_MATERIAL` includes `SYSTEM_RUNTIME_READ_ROOTS`, `DEVICE_READ_FILES` and every input of the writer-profile assembly, so that widening any of them changes the template digest.
   - RED: the material includes each one.
8. **No stopped orphans.**
   - When the controller cannot confirm closure, it SIGKILLs every pid the reaper reported stopping, after the E2-26c foreign-pid filter, before refusing.
   - RED: a failing lsof stub plus a background child that prints its pid. The exec refuses as unconfirmed, and within 2 s `process.kill(pid, 0)` throws `ESRCH`.
9. **Sweep trust rule (E4-7).** RED:
   - a stub that exits 1 with empty stdout means unconfirmed, not clean;
   - a stub whose output omits the controller pid means unconfirmed.
10. **E2-81 consistency test (platform any).** Every name in K1's `CCC_PLANNING_DENIED_NAMES` is matched by `cccConfinedEffectiveDeniedNames([])`. RED: the test fails if `.envrc` is removed from X1's defaults.
11. **Contract notes, no RED.**
    - The extra reason `instance-disposed` is listed in §2.13.
    - The RLIMIT_CPU risk row moves from the file header to §6 as risk 44: a per-pass syscall loop is bounded by the wall timer, not by RLIMIT_CPU.

**Frozen for X1b, which runs at the same time:**
- X1c changes no exported signature except:
  - (i) `dispose()` returns a result instead of void;
  - (ii) the factory's `testOnly` is narrowed to `{ lsofPath? }`.
- `sealCccToolchain`, `qualifyCccConfinedShell` and `CccSealedExecutable` keep their input shapes.

## E4-B: card X1b (moves earlier: W1 residual, starts now)

X1b runs per v3.1 §3.1 plus E4-5 and E4-15, based on INT-1b `ff4fc3e4f`, opus, critical. It depends on X1 only, and its files are new and disjoint from X1c's.
- It builds toolchains only through `sealCccToolchain`.
- It never passes `sealedEnvironment` to the factory.
- It exports `discoverCccToolchain(i: { searchPath: readonly string[]; required?: readonly string[] }): Promise<CccSealedToolchain>`, which G0, SF and WR use.
- Its Darwin tests share fixtures to keep the closed check under a measured bound. It sizes `timeoutMs` the X1c way.

## E4-C: contract v3.2

One editor compiles `CONTRACT-v3.2.md` from v3.1, E3 and E4, and an independent check follows (FREEZE or AMEND). Every later card reads v3.2.
