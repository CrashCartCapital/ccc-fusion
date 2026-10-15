# CONTRACT-v3 errata E1 — leader adjudication of the W1 card reviews (P0, K1, X1, S0)

Date: 2026-10-14. Binding on top of CONTRACT-v3.md. Where E1 and v3 disagree, E1 wins. Every item names the card that applies it.

## Proof runner and inventory (P0)
- **E1-1 Field name.** `needsPostgres` everywhere; it replaces `needsPg` in §2.20, §3.0 and all card text. The validator stays strict and names `needsPg` in its error.
- **E1-2 PostgreSQL-free commands.** The runner sets `FUSION_PG_TEST_SKIP=1` in the child env of every command without `needsPostgres`, so no vitest global setup probes the shared `:5432`. Risk row 10 ("refuses FUSION_PG_TEST_SKIP") means a caller-supplied value, which stays refused in every mode before any spawn. Mitigation for vacuous passes: the static skip policy refuses any literal `FUSION_PG_TEST_SKIP` inside a test file listed under a command WITHOUT `needsPostgres` (refusal plus positive control). Only `needsPostgres` commands get the owned URL, in `FUSION_PG_TEST_URL_BASE` and `CCC_PG_URL_BASE`, and the runner never sets the flag for them.
- **E1-2b PostgreSQL gate idiom.** Files listed under a `needsPostgres` command may use the existing idiom `const pgDescribe = PG_AVAILABLE ? describe : describe.skip;` with `PG_AVAILABLE` reading `FUSION_PG_TEST_SKIP` (see `packages/core/src/__tests__/postgres/schema-applier.test.ts:92-97`). The runtime closure is the backstop: 0 skipped, and every expected name passed. P0 adds tests for both cases:
  - this exact idiom in a `needsPostgres` file is accepted;
  - the same idiom in a file without `needsPostgres` is refused.
- **E1-3 Credential stripping.** In every mode, the runner removes provider credential variables from each child env: names ending `_API_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, and names starting `OMNIROUTE_`, `ANTHROPIC_`, `OPENAI_`, `GEMINI_`, `GOOGLE_`, `AWS_`, `AZURE_`, `MINIMAX_`, `ZHIPU_`, `GLM_`. The report records the count of stripped names only, never names or values.
- **E1-4 Report shape.** `perCommand[].files` and `postgres.stopError` are required, as frozen by ADR D Q1. Ratified additive widenings: `scratch.root: string | null`; cleanup values `"not-created"` and `"removal-failed: <reason>"`; refusal code `CCC_PLANNING_OFFLINE_NETWORK_ATTEMPT`; extra `runSupervised` fields. Document each in the runner's types header.
- **E1-5** The sandbox readiness probe uses the absolute `/usr/bin/sandbox-exec`, never PATH.
- **E1-6 Closure modes.** OFFLINE entries must be names-closed. TARGETED entries may be files-closed or names-closed.
- **E1-7 Masking.** The skip-policy lexer indexes UTF-16 code units (`text.split("")`), never code points. Tests: emoji then `.skip(` is refused; emoji then the Darwin `skipIf` is accepted in a darwin-tagged file.

## Core types and validators (K1)
- **E1-8 Proof results.** `CccPlanningProofResultsV1.results` follows §2.17 / item 46 exactly: one entry per proof id, `{proofId, attemptKey, state: "committed" | "proved_failed", resultSuccess, exitCode, durationMs, stdoutSha256, stderrSha256, terminalEnvelopeSha256}`. This corrects v3's "Deltas for in-flight cards", which omitted it.
- **E1-9 Fit with time gone.** `assessCccPlanningFit` and `assessCccBuildFit` accept any finite remaining time and `maxDurationMs`, including zero and negative values (fractions floored). These return `{ok:false, …, shortfalls:[{dimension:"time", …}]}` and never throw. `criticalPathMs` stays non-negative.
- **E1-10 Owned paths.** Overlap compares `normalize("NFC").toLowerCase()` after `./` and `..` normalization, because the default APFS volume on the I2 host ignores case and normalization form. The task-plan validator also refuses:
  - a duplicate owned path within one task;
  - any owned path with a `.git` segment;
  - any owned path whose basename is `.env` or starts with `.env.`.
- **E1-11 Derived keys.** Turn key, attempt key, linked-writer turn key, event id and run id each hash exactly their contract-named fields. A caller passing extra fields gets the same key.
- **E1-12 Verifier bundle.** A proof id is its Taskfile name. Each proof is `{id, requirementIds, files, taskfileTask}`. The id matches `^[a-z0-9][a-z0-9-]{0,62}$` and `taskfileTask === "verify:" + id`. Remove the root-level `taskfileTask` if item 41 leaves it no use; otherwise document what it names.
- **E1-13** Canonical-JSON encoding failures (undefined values, non-plain objects) refuse as `CccPlanningRefusal("CCC_PLANNING_ARTIFACT_ENVELOPE_INVALID")`, not a plain `Error`.
- **E1-14 Ratified.**
  - The marker treats `userPaused !== true` as unpaused, so an absent field counts as false.
  - `CccPlanningDecisionRecordV1.evidence` is `CccReviewFindingRef[]`.

## Migrations (S0)
- **E1-15 Anchor delete.** 0042 adds `REVOKE DELETE, TRUNCATE ON project.ccc_planning_runs FROM fusion_runtime;` right after the grant. The runtime never deletes anchor rows, and the FK to `tasks` is NO ACTION, so no cascade needs it.
  - RED: as `fusion_runtime`, a DELETE fails with SQLSTATE 42501. A delete-and-reinsert counter reset is refused.
  - The privilege test asserts SELECT, INSERT and UPDATE each true, and DELETE and TRUNCATE each false, one `has_table_privilege` call per privilege.
- **E1-16 Extra file.** S0 owns `packages/core/src/__tests__/postgres/ccc-prd-import-migration.pg.test.ts`. Drop `project.ccc_planning_runs` before `project.ccc_prd_imports`, and add `'0042', '0043'` to the bookkeeping delete with matching asserts.

## Confined shell (X1)
- **E1-17 Check line.** X1's closed check is `ccc-confined-shell.darwin.test.ts` only. `ccc-campaign-proof-sandbox.test.ts` runs as an outside regression check; its Darwin skip predates this work.
- **E1-18 Closure authority: controller-side sweep (ADR X1-R).** An in-sandbox reaper cannot be the closure authority, because a confined command can kill or freeze it (`(allow signal (target same-sandbox))`). Closure moves to the controller, which runs outside the sandbox.
  - **Unique per-instance toolchain.** Each confined-operations instance gets its own toolchain directory, cloned from the sealed toolchain with APFS `clonefile` (`fs.copyFile` with `COPYFILE_FICLONE`, falling back to a full copy across volumes). `process-exec` is allowed only under that directory. Prove that hard links and symlinks of those binaries into a write root are refused, or cannot be executed, and deny explicitly if needed.
  - **Sweep.** After every exec, including the error, timeout and qualification-failure paths, the controller enumerates every same-uid process whose executable lies in that directory, from outside the sandbox. First choice is `lsof -a -d txt -F p +d <dir>` via a supervised async spawn. Probe first and pick the method that argv[0] spoofing (`exec -a`) cannot fool.
  - **Kill order.** SIGSTOP every match, re-scan until no new pid appears, SIGKILL all, then verify none remain. Rounds are bounded.
  - **Outcomes.** If the sweep converges to zero, the closure is confirmed even when the reaper died or froze. If it does not converge, the result is `CLOSURE_UNCONFIRMED`. Quarantine then means moving the write roots out of place and closing the admitted loopback listener, not just flagging the worktree.
  - **The in-sandbox reaper stays** as a fast first line.
  - **REDs** (probes P4 and P6 from the X1 review):
    - a `setsid` escaper plus `kill -9 $PPID`;
    - a `setsid` escaper plus `kill -STOP $PPID` with a 2 s timeout.

    In both, the escaper is dead within a bounded time after `exec` returns, and its heartbeat file stops growing. Positive control: a normal command's closure is confirmed with zero survivors.
- **E1-19 G0 environment probe.** The probe plants its canary in the controller's own `process.env` (restored in `finally`). It asserts that the variable names inside the sandbox are a subset of the sealed keys, the `taskEnv` keys and `{PWD, SHLVL, _, OLDPWD}`. RED: a `sealedEnvironment` that spreads `process.env` must fail qualification.
- **E1-20 Hardening.**
  - Qualification records the `ESCAPER <pid>` line outside the throwing helper, and `finally` kills that pid. The tests that start escapers do the same.
  - `deniedNames` is always the union of the defaults and the caller's list; a caller cannot remove `.env`.
  - Writes to any path with a `.git` segment inside a write root are denied.
  - The template digest also covers `deniedNamePattern`, `sealedEnvironment` and the loopback rule.
  - Execs on one operations instance are serialized, so the last-closure record and the shared scratch home and tmp stay unambiguous.
  - The CPU-limit test loops on `process.cpuUsage()`, not wall time.

## Accepted residual risks (recorded, not fixed now)
- P0 lexer: a regex literal after `)` that contains `/*` can hide code. Inventory files are written by our own cards, not by Fusion's models.
- P0 refuses any `skip:` or `todo:` key, even in data. This fails closed.
- X1 has no process-count limit. A fork bomb shares the per-user limit, and the controller sweep stops processes before killing them.
- `glm/glm-5.2:latest`-style forms are labelled `floating-alias`; they are still refused.

## Carry-forward to later cards
- **H1/WR:** the graph executor treats `maxRetries: 0` as unset (`workflow-graph-executor.ts:2160-2163`). Pass explicit attempts.
- **L1/A1:** `TaskStore.recordRunAuditEvent` drops `eventId` (`task-store/project-store-ops.ts:516-526`). Call the data-layer function directly.
- **INT-1:** export `schema/ccc-planning.ts` from `schema/index.ts`, not from `project.ts`, which would create a module cycle.
